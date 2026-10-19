package com.kiosk.erp.core.data.repository

import androidx.room.withTransaction
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.database.KioskDatabase
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.database.SaleEntity
import com.kiosk.erp.core.database.SaleLineEntity
import com.kiosk.erp.core.database.SyncStateEntity
import com.kiosk.erp.core.database.TenderEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

data class CartLine(
    val productId: String?,
    val sku: String,
    val name: String,
    val unit: String,
    val quantity: Double,
    val unitPriceMinor: Long,
    val discountBp: Int = 0,
    val taxRateBp: Int = 0,
    val taxInclusive: Boolean = false,
)

/**
 * Writes sales locally in ONE transaction: sale + lines + tender + outbox. There is no network
 * call on the cashier path; the UI observes committed local data immediately (§1.6 rules 1–2).
 */
class SaleRepository(private val db: KioskDatabase) {

    data class CheckoutResult(val saleId: String, val localNumber: String, val totalMinor: Long)

    fun observeRecentSales(): Flow<List<SaleEntity>> = db.saleDao().observeRecent()
    fun observePendingCount(): Flow<Int> = db.outboxDao().observePendingCount()
    fun observePendingEntries(): Flow<List<OutboxEntity>> = db.outboxDao().observePendingEntries()
    fun observeNeedsAttention(): Flow<List<OutboxEntity>> = db.outboxDao().observeNeedsAttention()
    fun observeNeedsAttentionCount(): Flow<Int> = db.outboxDao().observeNeedsAttentionCount()
    fun observeGrossTotalMinor(): Flow<Long> = db.saleDao().observeGrossTotalMinor()
    fun observePendingTotalMinor(): Flow<Long> = db.saleDao().observePendingTotalMinor()
    fun observeSaleCount(): Flow<Int> = db.saleDao().observeSaleCount()
    fun observeOldestPending(): Flow<Long?> = db.outboxDao().observeOldestPendingEpochMs()
    fun observeSyncState(): Flow<SyncStateEntity?> = db.syncStateDao().observe()

    suspend fun ensureSyncState() {
        if (db.syncStateDao().get() == null) {
            db.syncStateDao().upsert(
                SyncStateEntity(id = 1, cursor = 0, lastPushAtEpochMs = null, lastPullAtEpochMs = null, serverReachable = false, lastError = null),
            )
        }
    }

    /** Record a cash sale offline. Provisional local receipt number; never recycled (§7, ADR 0006). */
    suspend fun createCashSale(customerId: String?, lines: List<CartLine>, branchId: String, deviceId: String): CheckoutResult {
        require(lines.isNotEmpty()) { "Cart is empty" }
        val saleId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val localNumber = "LL-${saleId.take(8).uppercase()}"

        val totals = Pricing.computeDocument(
            lines.map { Pricing.LineInput(it.unitPriceMinor, it.quantity, it.discountBp, it.taxRateBp, it.taxInclusive) },
        )

        val lineEntities = lines.map { line ->
            val r = Pricing.computeLine(Pricing.LineInput(line.unitPriceMinor, line.quantity, line.discountBp, line.taxRateBp, line.taxInclusive))
            SaleLineEntity(
                id = UUID.randomUUID().toString(),
                saleId = saleId,
                productId = line.productId,
                sku = line.sku,
                name = line.name,
                unit = line.unit,
                quantity = line.quantity,
                unitPriceMinor = line.unitPriceMinor,
                discountBp = line.discountBp,
                discountMinor = r.discountMinor,
                taxRateBp = line.taxRateBp,
                taxInclusive = line.taxInclusive,
                netMinor = r.netMinor,
                taxMinor = r.taxMinor,
                lineTotalMinor = r.lineTotalMinor,
            )
        }

        val tenderId = UUID.randomUUID().toString()
        val commandId = UUID.randomUUID().toString()

        val sale = SaleEntity(
            id = saleId,
            localNumber = localNumber,
            customerId = customerId,
            cashSessionId = null,
            state = "pending_sync",
            currency = "KES",
            subtotalMinor = totals.subtotalMinor,
            discountMinor = totals.discountTotalMinor,
            taxTotalMinor = totals.taxTotalMinor,
            totalMinor = totals.totalMinor,
            conflictReason = null,
            serverSeq = null,
            createdAtEpochMs = now,
            syncedAtEpochMs = null,
        )

        val payload = buildJsonObject {
            put("sale", buildJsonObject {
                put("id", saleId)
                put("localNumber", localNumber)
                if (customerId != null) put("customerId", customerId)
                put("currency", "KES")
                put("clientCreatedAt", isoNow())
                put("lines", buildJsonArray {
                    lineEntities.forEach { l ->
                        add(buildJsonObject {
                            put("id", l.id)
                            if (l.productId != null) put("productId", l.productId)
                            put("sku", l.sku)
                            put("name", l.name)
                            put("unit", l.unit)
                            put("quantity", l.quantity)
                            put("unitPriceMinor", l.unitPriceMinor)
                            put("discountBp", l.discountBp)
                            put("taxRateBp", l.taxRateBp)
                            put("taxInclusive", l.taxInclusive)
                        })
                    }
                })
                put("tenders", buildJsonArray {
                    add(buildJsonObject {
                        put("id", tenderId)
                        put("method", "cash")
                        put("amountMinor", totals.totalMinor)
                    })
                })
            })
        }

        db.withTransaction {
            db.saleDao().insertSale(sale)
            db.saleDao().insertLines(lineEntities)
            db.saleDao().insertTenders(
                listOf(TenderEntity(id = tenderId, saleId = saleId, method = "cash", amountMinor = totals.totalMinor, status = "recorded", externalReference = null)),
            )
            db.outboxDao().insert(
                OutboxEntity(
                    commandId = commandId,
                    aggregateType = "Sale",
                    aggregateId = saleId,
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

        return CheckoutResult(saleId, localNumber, totals.totalMinor)
    }

    private fun isoNow(): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(java.util.Date())
    }
}
