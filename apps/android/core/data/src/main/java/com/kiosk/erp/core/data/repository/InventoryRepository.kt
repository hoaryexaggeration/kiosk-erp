package com.kiosk.erp.core.data.repository

import androidx.room.withTransaction
import com.kiosk.erp.core.database.BranchEntity
import com.kiosk.erp.core.database.KioskDatabase
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.database.StockBalanceEntity
import com.kiosk.erp.core.database.StockTransferEntity
import com.kiosk.erp.core.database.StockTransferLineEntity
import com.kiosk.erp.core.network.ServerBalance
import com.kiosk.erp.core.network.ServerBranch
import com.kiosk.erp.core.network.ServerTransfer
import com.kiosk.erp.core.network.ServerTransferLine
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID

/**
 * Offline stock movements. The server owns stock (append-only movements); a device records the
 * operator's intent in the outbox and updates its cached projection so the UI stays truthful.
 * A device NEVER computes authoritative on-hand (§6).
 */
class InventoryRepository(private val db: KioskDatabase) {

    data class AdjustmentResult(val adjustmentId: String)

    fun observeBalances(): Flow<List<StockBalanceEntity>> = db.inventoryDao().observeBalances()

    /** Replace the cached on-hand projection with the server's derived balances. */
    suspend fun cacheBalances(balances: List<ServerBalance>) {
        val now = System.currentTimeMillis()
        db.inventoryDao().upsertAll(
            balances.map {
                StockBalanceEntity(
                    productId = it.productId,
                    branchId = it.branchId,
                    sku = it.sku,
                    name = it.name,
                    quantity = it.quantity,
                    updatedAtEpochMs = now,
                )
            },
        )
    }

    /**
     * Queue a stock adjustment. `reason` is mandatory — an unexplained movement is not a fact we
     * are willing to post (mirrors the server's `StockAdjustment` contract).
     *
     * Item 4.6: an adjustment may be WRITTEN in a pack (`10 crate`) and is posted that way, so the
     * server converts it and records both numbers on the movement. The device never converts for the
     * ledger — it only reports the base-unit effect it believes will happen, which is what the local
     * on-hand projection needs to stay honest until the next pull.
     *
     * @param enteredQuantityDelta the quantity as the operator typed it, in `unit`
     * @param unit the pack they typed it in, or null for the product's base unit
     * @param baseQuantityDelta the effect in base units, already converted by `Units` for the preview
     */
    suspend fun createAdjustment(
        productId: String,
        sku: String,
        name: String,
        enteredQuantityDelta: Double,
        unit: String?,
        baseQuantityDelta: Double,
        reason: String,
        branchId: String,
        deviceId: String,
    ): AdjustmentResult {
        val adjustmentId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()

        val payload = buildJsonObject {
            put("adjustment", buildJsonObject {
                put("id", adjustmentId)
                put("reason", reason)
                put("lines", buildJsonArray {
                    add(buildJsonObject {
                        put("productId", productId)
                        put("quantityDelta", enteredQuantityDelta)
                        if (unit != null) put("unit", unit)
                    })
                })
            })
        }

        db.withTransaction {
            val existing = db.inventoryDao().byProduct(productId)
            db.inventoryDao().upsertAll(
                listOf(
                    existing?.copy(quantity = existing.quantity + baseQuantityDelta, updatedAtEpochMs = now)
                        ?: StockBalanceEntity(
                            productId = productId,
                            branchId = branchId,
                            sku = sku,
                            name = name,
                            quantity = baseQuantityDelta,
                            updatedAtEpochMs = now,
                        ),
                ),
            )
            db.outboxDao().insert(
                OutboxEntity(
                    commandId = UUID.randomUUID().toString(),
                    aggregateType = "StockAdjustment",
                    aggregateId = adjustmentId,
                    branchId = branchId,
                    deviceId = deviceId,
                    payloadJson = payload.toString(),
                    status = "pending",
                    attempts = 0,
                    lastError = null,
                    conflictCode = null,
                    createdAtEpochMs = now,
                    syncedAtEpochMs = null,
                ),
            )
        }

        return AdjustmentResult(adjustmentId)
    }

    // --- cross-branch transfers (item 4.7, ADR 0008) ---------------------------------------------

    /** One line as the operator built it on screen: the quantity typed, and its effect in base units. */
    data class TransferLineDraft(
        val productId: String,
        val sku: String,
        val name: String,
        val baseUnit: String,
        /** What was typed, in `enteredUnit` — the paperwork the server converts itself. */
        val enteredQuantity: Double,
        /** The pack it was written in, or null when it was written in the base unit. */
        val enteredUnit: String?,
        /** The device's projection of the effect in base units — a hint, never the authority (§6). */
        val baseQuantity: Double,
    )

    fun observeTransfers(): Flow<List<StockTransferEntity>> = db.transferDao().observeTransfers()
    fun observeTransferLines(): Flow<List<StockTransferLineEntity>> = db.transferDao().observeLines()
    fun observeBranches(): Flow<List<BranchEntity>> = db.branchDao().observeAll()

    /** Every outbox command this device has ever sent about a transfer, newest first. */
    fun observeTransferCommands(): Flow<List<OutboxEntity>> = db.outboxDao().observeForType("StockTransfer")

    /** Replace the cached transfer list with what the server reports for this branch. */
    suspend fun cacheTransfers(rows: List<ServerTransfer>) {
        db.withTransaction {
            db.transferDao().upsertTransfers(rows.map { it.toEntity() })
            db.transferDao().upsertLines(rows.flatMap { transfer -> transfer.lines.map { it.toEntity(transfer.id) } })
            // Only SERVER-known documents may be pruned: a dispatch queued on this device has no
            // server row yet, and its absence from the list is not a verdict on it (§1.6 rule 2).
            if (rows.isEmpty()) db.transferDao().clearSynced() else db.transferDao().pruneSyncedExcept(rows.map { it.id })
            db.transferDao().pruneOrphanLines()
        }
    }

    /** Replace the branch list the destination picker chooses from — a SET, like every config set. */
    suspend fun cacheBranches(rows: List<ServerBranch>) {
        // An empty answer is not a branch list; it is a failed one. Never empty the picker.
        if (rows.isEmpty()) return
        db.withTransaction {
            db.branchDao().upsertAll(rows.map { BranchEntity(id = it.id, code = it.code, name = it.name) })
            db.branchDao().pruneExcept(rows.map { it.id })
        }
    }

    /** A receipt for this document is already waiting to post — queueing a second one is a mistake. */
    suspend fun hasQueuedReceipt(transferId: String): Boolean =
        db.outboxDao().pendingReceiptCount(aggregateType = "StockTransfer", aggregateId = transferId) > 0

    /**
     * Queue a dispatch: this branch's goods leave for another, as ONE document the destination will
     * later count against (item 4.7). The command carries what was TYPED (`2 crate`) and the server
     * does the conversion and the costed FIFO consumption itself; `baseQuantity` only keeps the local
     * on-hand projection honest until the next pull, exactly like an adjustment.
     */
    suspend fun createTransfer(
        lines: List<TransferLineDraft>,
        fromBranchId: String,
        fromBranchName: String,
        toBranchId: String,
        toBranchName: String,
        note: String?,
        approvalNote: String?,
        deviceId: String,
    ): String {
        val transferId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val payload = buildJsonObject {
            put("action", "dispatch")
            put("transfer", buildJsonObject {
                put("id", transferId)
                put("toBranchId", toBranchId)
                if (!note.isNullOrBlank()) put("note", note.trim())
                // Only needed when the dispatch would leave this branch below zero; present when it
                // is, absent when it is not, exactly as the server's contract asks (§3.D).
                if (!approvalNote.isNullOrBlank()) put("approvalNote", approvalNote.trim())
                put("lines", buildJsonArray {
                    lines.forEach { line ->
                        add(buildJsonObject {
                            put("productId", line.productId)
                            put("quantity", line.enteredQuantity)
                            line.enteredUnit?.let { put("unit", it) }
                        })
                    }
                })
            })
        }

        db.withTransaction {
            db.transferDao().upsertTransfers(
                listOf(
                    StockTransferEntity(
                        id = transferId,
                        // No number until the server issues one from the tenant series.
                        reference = "",
                        fromBranchId = fromBranchId,
                        toBranchId = toBranchId,
                        fromBranchName = fromBranchName,
                        toBranchName = toBranchName,
                        status = "dispatched",
                        note = note?.trim()?.takeIf { it.isNotEmpty() },
                        approvalNote = approvalNote?.trim()?.takeIf { it.isNotEmpty() },
                        dispatchedAt = Instant.now().toString(),
                        receivedAt = null,
                        lineCount = lines.size,
                        inTransitQuantity = lines.sumOf { it.baseQuantity },
                        shortageQuantity = 0.0,
                        synced = false,
                    ),
                ),
            )
            db.transferDao().upsertLines(
                lines.map { line ->
                    StockTransferLineEntity(
                        transferId = transferId,
                        productId = line.productId,
                        sku = line.sku,
                        name = line.name,
                        unit = line.baseUnit,
                        enteredUnit = line.enteredUnit,
                        enteredQuantity = line.enteredQuantity,
                        dispatched = line.baseQuantity,
                        received = null,
                        // The server values what travelled; until it has, this device has no
                        // costed figure worth showing (ADR 0009).
                        unitCostMinor = 0L,
                        shortage = 0.0,
                    )
                },
            )
            lines.forEach { line -> addToBalance(line.productId, fromBranchId, line.sku, line.name, -line.baseQuantity, now) }
            db.outboxDao().insert(
                OutboxEntity(
                    commandId = UUID.randomUUID().toString(),
                    aggregateType = "StockTransfer",
                    aggregateId = transferId,
                    branchId = fromBranchId,
                    deviceId = deviceId,
                    payloadJson = payload.toString(),
                    status = "pending",
                    attempts = 0,
                    lastError = null,
                    conflictCode = null,
                    createdAtEpochMs = now,
                    syncedAtEpochMs = null,
                ),
            )
        }
        return transferId
    }

    /**
     * Queue a receipt: the destination counts what arrived and closes the document with that count
     * (item 4.7). `received` is per line in base units and must account for EVERY dispatched line —
     * a missing line is a stale receipt, an invented one is somebody else's goods, and the server
     * refuses both. A shortage without `approvalNote` is refused too, so the screen asks first.
     */
    suspend fun receiveTransfer(
        transfer: StockTransferEntity,
        received: Map<String, Double>,
        approvalNote: String?,
        deviceId: String,
    ) {
        val now = System.currentTimeMillis()
        val documentLines = db.transferDao().linesFor(transfer.id)
        val payload = buildJsonObject {
            put("action", "receive")
            put("transfer", buildJsonObject {
                put("id", transfer.id)
                if (!approvalNote.isNullOrBlank()) put("approvalNote", approvalNote.trim())
                put("lines", buildJsonArray {
                    documentLines.forEach { line ->
                        add(buildJsonObject {
                            put("productId", line.productId)
                            put("quantityReceived", received[line.productId] ?: line.dispatched)
                        })
                    }
                })
            })
        }

        val shortage = documentLines.sumOf { line -> Math.max(line.dispatched - (received[line.productId] ?: line.dispatched), 0.0) }

        db.withTransaction {
            db.transferDao().upsertTransfers(
                listOf(
                    transfer.copy(
                        // The device does not decide the outcome; it records what it counted and
                        // the server rules on it. The optimistic state matches what that count
                        // means if the server agrees.
                        status = if (shortage > 0.0) "discrepancy" else "received",
                        receivedAt = Instant.now().toString(),
                        approvalNote = approvalNote?.trim()?.takeIf { it.isNotEmpty() } ?: transfer.approvalNote,
                        inTransitQuantity = 0.0,
                        shortageQuantity = shortage,
                    ),
                ),
            )
            db.transferDao().upsertLines(
                documentLines.map { line ->
                    val counted = received[line.productId] ?: line.dispatched
                    line.copy(
                        received = counted,
                        shortage = Math.max(line.dispatched - counted, 0.0),
                    )
                },
            )
            documentLines.forEach { line ->
                addToBalance(line.productId, transfer.toBranchId, line.sku, line.name, received[line.productId] ?: 0.0, now)
            }
            db.outboxDao().insert(
                OutboxEntity(
                    commandId = UUID.randomUUID().toString(),
                    aggregateType = "StockTransfer",
                    aggregateId = transfer.id,
                    branchId = transfer.toBranchId,
                    deviceId = deviceId,
                    payloadJson = payload.toString(),
                    status = "pending",
                    attempts = 0,
                    lastError = null,
                    conflictCode = null,
                    createdAtEpochMs = now,
                    syncedAtEpochMs = null,
                ),
            )
        }
    }

    /**
     * Nudge the cached on-hand projection by the effect a queued transfer will have. A projection,
     * not a balance: the next pull replaces it with the server's own number (§6).
     */
    private suspend fun addToBalance(productId: String, branchId: String, sku: String, name: String, delta: Double, now: Long) {
        val existing = db.inventoryDao().byProduct(productId)
        db.inventoryDao().upsertAll(
            listOf(
                existing?.copy(quantity = existing.quantity + delta, updatedAtEpochMs = now)
                    ?: StockBalanceEntity(
                        productId = productId,
                        branchId = branchId,
                        sku = sku,
                        name = name,
                        quantity = delta,
                        updatedAtEpochMs = now,
                    ),
            ),
        )
    }

    private fun ServerTransfer.toEntity() = StockTransferEntity(
        id = id,
        reference = reference,
        fromBranchId = fromBranchId,
        toBranchId = toBranchId,
        fromBranchName = fromBranchName,
        toBranchName = toBranchName,
        status = status,
        note = note,
        approvalNote = approvalNote,
        dispatchedAt = dispatchedAt,
        receivedAt = receivedAt,
        lineCount = lineCount,
        inTransitQuantity = inTransitQuantity,
        shortageQuantity = shortageQuantity,
        synced = true,
    )

    private fun ServerTransferLine.toEntity(transferId: String) = StockTransferLineEntity(
        transferId = transferId,
        productId = productId,
        sku = sku,
        name = name,
        unit = unit,
        enteredUnit = enteredUnit,
        enteredQuantity = enteredQuantity,
        dispatched = dispatched,
        received = received,
        unitCostMinor = unitCostMinor,
        shortage = shortage,
    )
}
