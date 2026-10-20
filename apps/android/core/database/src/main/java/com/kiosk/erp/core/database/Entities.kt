package com.kiosk.erp.core.database

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
    val description: String? = null,
    val categoryId: String? = null,
    val taxCategoryId: String? = null,
    /** Brand (item 4.6). `brandName` is denormalised so a list can show it without a join. */
    val brandId: String? = null,
    val brandName: String? = null,
    /**
     * The `kind` of the base unit (`count`, `weight` or `volume`), or null when that unit is not in
     * the shop's vocabulary. It travels with the product because it belongs to the product's
     * conversions: a crate count must land on a whole number, a weigh may not — and a product can
     * only HAVE pack sizes if its base unit is a typed one, so this is exactly where the rule is
     * needed, available offline on the same pull that brings the pack sizes themselves.
     */
    val unitKind: String? = null,
    /**
     * Low-stock threshold in base units (item 4.9), or null when nobody is watching this line. It
     * ships with the product so the Stock screen can flag the breach from its own cache, offline.
     */
    val reorderPoint: Double? = null,
    val isActive: Boolean = true,
)

@Entity(tableName = "barcodes", indices = [Index(value = ["barcode"], unique = true)])
data class BarcodeEntity(
    @PrimaryKey val barcode: String,
    val productId: String,
)

/**
 * A product's pack sizes (item 4.6): `1 <unit> = <factor> <product.unit>`. Stored as a SET keyed by
 * product and unit, replaced wholesale from the server like barcodes — a pack size retired on the
 * server must stop converting on the device too, because the receipt it validates is posted there.
 *
 * `factor` is against the product's base unit, which is why this table hangs off the product and not
 * off the unit: a crate is 24 bottles of soda and 12 of water.
 */
@Entity(tableName = "product_conversions", primaryKeys = ["productId", "unit"])
data class ProductConversionEntity(
    val productId: String,
    val unit: String,
    val factor: Double,
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

/**
 * Server-derived on-hand snapshot cached for offline reads. It is a projection, NOT the source of
 * truth: the server owns stock (append-only movements). Local adjustments are queued in the outbox.
 */
@Entity(tableName = "stock_balances", primaryKeys = ["productId", "branchId"])
data class StockBalanceEntity(
    val productId: String,
    val branchId: String,
    val sku: String,
    val name: String,
    val quantity: Double,
    val updatedAtEpochMs: Long,
)

/**
 * A branch of this tenant (item 4.7), cached so a transfer's destination can be picked with the
 * network down. A SET like barcodes and pack sizes: replaced wholesale from the config snapshot, so
 * a branch retired on the server stops being a destination here too.
 */
@Entity(tableName = "branches")
data class BranchEntity(
    @PrimaryKey val id: String,
    val code: String,
    val name: String,
)

/**
 * A cross-branch transfer document (item 4.7, ADR 0008), cached for offline reading.
 *
 * `synced == false` means only this device has ever seen it — a dispatch queued on the shelf with
 * no document number yet. `reference` is blank until the server issues `TRF-nnnn`, because a device
 * must never invent a document number the server's tenant-wide series owns.
 */
@Entity(tableName = "stock_transfers")
data class StockTransferEntity(
    @PrimaryKey val id: String,
    /** Blank while queued; `TRF-0001` once the server has issued it from the tenant series. */
    val reference: String,
    val fromBranchId: String,
    val toBranchId: String,
    val fromBranchName: String,
    val toBranchName: String,
    /** `dispatched` | `received` | `discrepancy` — the server's states, verbatim. */
    val status: String,
    val note: String?,
    val approvalNote: String?,
    val dispatchedAt: String,
    val receivedAt: String?,
    val lineCount: Int,
    /** Units out on this document right now; 0 once it has arrived (whatever is short did not). */
    val inTransitQuantity: Double,
    val shortageQuantity: Double,
    /** True once the server has reported this document, false while only this device holds it. */
    val synced: Boolean,
)

/**
 * One line of a transfer: what was sent, what arrived, and what the paperwork said the quantity was
 * written in (item 4.6/4.7). `received` is null until the destination has counted it.
 */
@Entity(tableName = "stock_transfer_lines", primaryKeys = ["transferId", "productId"])
data class StockTransferLineEntity(
    val transferId: String,
    val productId: String,
    val sku: String,
    val name: String,
    /** The base unit stock is held in — the unit `dispatched` and `received` are counted in. */
    val unit: String,
    /** The pack it was written in, when a pack was used: "2 crate" for 48 ea. */
    val enteredUnit: String?,
    val enteredQuantity: Double?,
    val dispatched: Double,
    val received: Double?,
    /** Cost per base unit that travelled with the goods (ADR 0009); 0 while still queued. */
    val unitCostMinor: Long,
    /** What the destination came up short — 0 until the document has been received. */
    val shortage: Double,
)

