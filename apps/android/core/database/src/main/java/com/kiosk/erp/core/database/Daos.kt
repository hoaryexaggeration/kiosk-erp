package com.kiosk.erp.core.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ProductDao {
    @Query("SELECT * FROM products ORDER BY name ASC")
    fun observeAll(): Flow<List<ProductEntity>>

    @Query("SELECT COUNT(*) FROM products")
    suspend fun count(): Int

    @Query("SELECT * FROM products WHERE id = :id")
    suspend fun byId(id: String): ProductEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(products: List<ProductEntity>)

    @Query("SELECT p.* FROM products p JOIN barcodes b ON b.productId = p.id WHERE b.barcode = :barcode")
    suspend fun byBarcode(barcode: String): ProductEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertBarcodes(barcodes: List<BarcodeEntity>)

    /** Barcodes are a SET, not an append-only log: a tag removed on the server must stop resolving. */
    @Query("DELETE FROM barcodes WHERE productId = :productId")
    suspend fun deleteBarcodesFor(productId: String)

    @Query("SELECT barcode FROM barcodes WHERE productId = :productId ORDER BY barcode ASC")
    suspend fun barcodesFor(productId: String): List<String>

    /**
     * Pack sizes for one product (item 4.6), ordered so the editor, the preview and the till always
     * read the same set in the same order. `factor` is how many base units one of that unit is worth.
     */
    @Query("SELECT * FROM product_conversions WHERE productId = :productId ORDER BY unit ASC")
    suspend fun conversionsFor(productId: String): List<ProductConversionEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertConversions(conversions: List<ProductConversionEntity>)

    /** Conversions are a SET, not an append-only log: a pack retired on the server must stop converting here. */
    @Query("DELETE FROM product_conversions WHERE productId = :productId")
    suspend fun deleteConversionsFor(productId: String)

    /**
     * Catalogue search for the management screen. Matches name, SKU or barcode so a shopkeeper can
     * find an item by whichever identifier they have. Capped so a 20 000-SKU catalogue stays snappy.
     */
    @Query(
        "SELECT p.* FROM products p WHERE :query = '' OR p.name LIKE '%' || :query || '%' " +
            "OR p.sku LIKE '%' || :query || '%' " +
            "OR EXISTS (SELECT 1 FROM barcodes b WHERE b.productId = p.id AND b.barcode LIKE '%' || :query || '%') " +
            "ORDER BY p.isActive DESC, p.name ASC LIMIT 500",
    )
    fun observeMatching(query: String): Flow<List<ProductEntity>>
}

@Dao
interface SaleDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertSale(sale: SaleEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertLines(lines: List<SaleLineEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertTenders(tenders: List<TenderEntity>)

    @Query("SELECT * FROM sales ORDER BY createdAtEpochMs DESC LIMIT 50")
    fun observeRecent(): Flow<List<SaleEntity>>

    @Query("SELECT * FROM sales WHERE id = :id")
    suspend fun byId(id: String): SaleEntity?

    @Query("SELECT * FROM sale_lines WHERE saleId = :saleId")
    suspend fun linesFor(saleId: String): List<SaleLineEntity>

    @Query("SELECT * FROM tenders WHERE saleId = :saleId")
    suspend fun tendersFor(saleId: String): List<TenderEntity>

    @Query("UPDATE sales SET state = :state, serverSeq = :serverSeq, syncedAtEpochMs = :at, conflictReason = :reason WHERE id = :id")
    suspend fun markSynced(id: String, state: String, serverSeq: Long?, at: Long, reason: String?)

    @Query("SELECT COALESCE(SUM(totalMinor), 0) FROM sales WHERE state IN ('accepted','review_required')")
    fun observeGrossTotalMinor(): Flow<Long>

    /**
     * Provisional total: recorded on this device, not yet accepted by the server. Shown separately
     * from the accepted total so an unsynced figure is never presented as posted money (§7).
     */
    @Query("SELECT COALESCE(SUM(totalMinor), 0) FROM sales WHERE state = 'pending_sync'")
    fun observePendingTotalMinor(): Flow<Long>

    @Query("SELECT COUNT(*) FROM sales")
    fun observeSaleCount(): Flow<Int>
}

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(entry: OutboxEntity)

    @Query("SELECT * FROM outbox WHERE status IN ('pending','retryable') ORDER BY createdAtEpochMs ASC LIMIT :limit")
    suspend fun pending(limit: Int = 50): List<OutboxEntity>

    /** The same queue as a stream, so the Sync Centre can show what is waiting without polling. */
    @Query("SELECT * FROM outbox WHERE status IN ('pending','retryable') ORDER BY createdAtEpochMs ASC")
    fun observePendingEntries(): Flow<List<OutboxEntity>>

    @Query("SELECT * FROM outbox WHERE commandId = :commandId")
    suspend fun byId(commandId: String): OutboxEntity?

    @Query("SELECT COUNT(*) FROM outbox WHERE status = 'pending'")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox WHERE status IN ('rejected','conflict','review_required')")
    fun observeNeedsAttentionCount(): Flow<Int>

    @Query("SELECT * FROM outbox WHERE status IN ('rejected','conflict','review_required') ORDER BY createdAtEpochMs DESC")
    fun observeNeedsAttention(): Flow<List<OutboxEntity>>

    /**
     * Every command of one aggregate type, newest first — how the transfers list joins a document to
     * what this device has most recently told the server about it (queued, accepted, needs attention).
     */
    @Query("SELECT * FROM outbox WHERE aggregateType = :aggregateType ORDER BY createdAtEpochMs DESC")
    fun observeForType(aggregateType: String): Flow<List<OutboxEntity>>

    /**
     * How many commands for this one document are still waiting to post. A receipt that is already
     * queued must not be queued again — the second would post as a duplicate and come back as a
     * rejection nobody asked for.
     */
    @Query(
        "SELECT COUNT(*) FROM outbox WHERE aggregateType = :aggregateType AND aggregateId = :aggregateId " +
            "AND status IN ('pending','retryable')",
    )
    suspend fun pendingReceiptCount(aggregateType: String, aggregateId: String): Int

    @Query("SELECT MIN(createdAtEpochMs) FROM outbox WHERE status = 'pending'")
    fun observeOldestPendingEpochMs(): Flow<Long?>

    @Update
    suspend fun update(entry: OutboxEntity)

    @Query("UPDATE outbox SET status = :status, attempts = attempts + 1, lastError = :error, conflictCode = :conflictCode, syncedAtEpochMs = :at WHERE commandId = :commandId")
    suspend fun markResult(commandId: String, status: String, error: String?, conflictCode: String?, at: Long)
}

@Dao
interface SyncStateDao {
    @Query("SELECT * FROM sync_state WHERE id = 1")
    suspend fun get(): SyncStateEntity?

    @Query("SELECT * FROM sync_state WHERE id = 1")
    fun observe(): Flow<SyncStateEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(state: SyncStateEntity)
}

@Dao
interface InventoryDao {
    @Query("SELECT * FROM stock_balances ORDER BY name ASC")
    fun observeBalances(): Flow<List<StockBalanceEntity>>

    @Query("SELECT * FROM stock_balances WHERE productId = :productId LIMIT 1")
    suspend fun byProduct(productId: String): StockBalanceEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(balances: List<StockBalanceEntity>)

    @Query("DELETE FROM stock_balances")
    suspend fun clear()
}

/**
 * Cross-branch transfers (item 4.7), cached so what is in transit is readable offline — "what did
 * we send, what is coming to us" is a shelf question, asked with the network down as often as up.
 */
@Dao
interface TransferDao {
    /** Newest first: the newest thing anyone did with a document is what an operator needs first. */
    @Query("SELECT * FROM stock_transfers ORDER BY dispatchedAt DESC")
    fun observeTransfers(): Flow<List<StockTransferEntity>>

    @Query("SELECT * FROM stock_transfers WHERE id = :id")
    suspend fun byId(id: String): StockTransferEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTransfers(transfers: List<StockTransferEntity>)

    /**
     * Only documents this device has been TOLD about are removed when they vanish from the server's
     * list. A dispatch queued at the shelf with no connection yet has no server row to be reported
     * against, and deleting it would delete work nobody has seen (§1.6 rule 2).
     */
    @Query("DELETE FROM stock_transfers WHERE synced = 1 AND id NOT IN (:ids)")
    suspend fun pruneSyncedExcept(ids: List<String>)

    @Query("DELETE FROM stock_transfers WHERE synced = 1")
    suspend fun clearSynced()

    @Query("SELECT * FROM stock_transfer_lines")
    fun observeLines(): Flow<List<StockTransferLineEntity>>

    @Query("SELECT * FROM stock_transfer_lines WHERE transferId = :transferId")
    suspend fun linesFor(transferId: String): List<StockTransferLineEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLines(lines: List<StockTransferLineEntity>)

    /** Lines whose document is gone would linger forever otherwise — they carry no meaning alone. */
    @Query("DELETE FROM stock_transfer_lines WHERE transferId NOT IN (SELECT id FROM stock_transfers)")
    suspend fun pruneOrphanLines()
}

/** The tenant's branches, replaced wholesale from the config snapshot (item 4.7). */
@Dao
interface BranchDao {
    @Query("SELECT * FROM branches ORDER BY name ASC")
    fun observeAll(): Flow<List<BranchEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(branches: List<BranchEntity>)

    @Query("DELETE FROM branches WHERE id NOT IN (:ids)")
    suspend fun pruneExcept(ids: List<String>)

    @Query("SELECT COUNT(*) FROM branches")
    suspend fun count(): Int
}
