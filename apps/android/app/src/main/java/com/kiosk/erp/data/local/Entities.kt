package com.kiosk.erp.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Cached catalogue (offline-first reads, architecture §6). */
@Entity(tableName = "products", indices = [Index(value = ["sku"], unique = true)])
data class ProductEntity(
    @PrimaryKey val id: String,
    val sku: String,
    val name: String,
    val unit: String,
    val priceMinor: Long,
    val costMinor: Long,
    val taxRateBp: Int,
    val taxInclusive: Boolean,
    val isStockTracked: Boolean,
    val version: Int,
    val updatedAtEpochMs: Long,
)

@Entity(tableName = "barcodes", indices = [Index(value = ["barcode"], unique = true)])
data class BarcodeEntity(
    @PrimaryKey val barcode: String,
    val productId: String,
)

/** A local sale. `state` follows the fixture state machine; never silently lost. */
@Entity(tableName = "sales")
data class SaleEntity(
    @PrimaryKey val id: String,
    val localNumber: String,
    val customerId: String?,
    val cashSessionId: String?,
    val state: String,
    val currency: String,
    val subtotalMinor: Long,
    val discountMinor: Long,
    val taxTotalMinor: Long,
    val totalMinor: Long,
    val conflictReason: String?,
    val serverSeq: Long?,
    val createdAtEpochMs: Long,
    val syncedAtEpochMs: Long?,
)

@Entity(tableName = "sale_lines", indices = [Index(value = ["saleId"])])
data class SaleLineEntity(
    @PrimaryKey val id: String,
    val saleId: String,
    val productId: String?,
    val sku: String,
    val name: String,
    val unit: String,
    val quantity: Double,
    val unitPriceMinor: Long,
    val discountBp: Int,
    val discountMinor: Long,
    val taxRateBp: Int,
    val taxInclusive: Boolean,
    val netMinor: Long,
    val taxMinor: Long,
    val lineTotalMinor: Long,
)

@Entity(tableName = "tenders", indices = [Index(value = ["saleId"])])
data class TenderEntity(
    @PrimaryKey val id: String,
    val saleId: String,
    val method: String,
    val amountMinor: Long,
    val status: String,
    val externalReference: String?,
)

/**
 * Durable command outbox. Lives in the SAME database as the business transaction so a sale and
 * its outbox entry commit together or not at all (§1.6 rule 2, §6).
 */
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val commandId: String,
    val aggregateType: String,
    val aggregateId: String,
    val branchId: String,
    val deviceId: String,
    val payloadJson: String,
    val status: String,           // pending | accepted | rejected | conflict | review_required | retryable
    val attempts: Int,
    val lastError: String?,
    val conflictCode: String?,
    val createdAtEpochMs: Long,
    val syncedAtEpochMs: Long?,
)

/** Single-row sync checkpoint + freshness metadata. */
@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val id: Int = 1,
    val cursor: Long,
    val lastPushAtEpochMs: Long?,
    val lastPullAtEpochMs: Long?,
    val serverReachable: Boolean,
    val lastError: String?,
)
