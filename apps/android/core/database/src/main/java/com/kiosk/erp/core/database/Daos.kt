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
}

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(entry: OutboxEntity)

    @Query("SELECT * FROM outbox WHERE status IN ('pending','retryable') ORDER BY createdAtEpochMs ASC LIMIT :limit")
    suspend fun pending(limit: Int = 50): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE commandId = :commandId")
    suspend fun byId(commandId: String): OutboxEntity?

    @Query("SELECT COUNT(*) FROM outbox WHERE status = 'pending'")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox WHERE status IN ('rejected','conflict','review_required')")
    fun observeNeedsAttentionCount(): Flow<Int>

    @Query("SELECT * FROM outbox WHERE status IN ('rejected','conflict','review_required') ORDER BY createdAtEpochMs DESC")
    fun observeNeedsAttention(): Flow<List<OutboxEntity>>

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
