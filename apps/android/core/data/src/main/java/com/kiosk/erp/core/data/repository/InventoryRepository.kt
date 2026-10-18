package com.kiosk.erp.core.data.repository

import androidx.room.withTransaction
import com.kiosk.erp.core.database.KioskDatabase
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.database.StockBalanceEntity
import com.kiosk.erp.core.network.ServerBalance
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
     */
    suspend fun createAdjustment(
        productId: String,
        sku: String,
        name: String,
        quantityDelta: Double,
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
                        put("quantityDelta", quantityDelta)
                    })
                })
            })
        }

        db.withTransaction {
            val existing = db.inventoryDao().byProduct(productId)
            db.inventoryDao().upsertAll(
                listOf(
                    existing?.copy(quantity = existing.quantity + quantityDelta, updatedAtEpochMs = now)
                        ?: StockBalanceEntity(
                            productId = productId,
                            branchId = branchId,
                            sku = sku,
                            name = name,
                            quantity = quantityDelta,
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
}
