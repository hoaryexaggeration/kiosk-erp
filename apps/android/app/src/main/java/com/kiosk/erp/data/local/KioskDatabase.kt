package com.kiosk.erp.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Single local SQLite store (Room) for catalogue, operational records, the outbox and sync state.
 * All cashier-loop writes go through here first — no network round-trip (§1.6 rule 1).
 */
@Database(
    entities = [
        ProductEntity::class,
        BarcodeEntity::class,
        SaleEntity::class,
        SaleLineEntity::class,
        TenderEntity::class,
        OutboxEntity::class,
        SyncStateEntity::class,
        StockBalanceEntity::class,
    ],
    version = 2,
    exportSchema = false,
)
abstract class KioskDatabase : RoomDatabase() {
    abstract fun productDao(): ProductDao
    abstract fun saleDao(): SaleDao
    abstract fun outboxDao(): OutboxDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun inventoryDao(): InventoryDao

    companion object {
        /**
         * v1 → v2 adds the cached stock-balance projection. A real migration (not a destructive
         * fallback) is mandatory: the local DB also holds sales that have not synced yet, and
         * dropping the database would destroy them (§1.6 rule 2).
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `stock_balances` (" +
                        "`productId` TEXT NOT NULL, " +
                        "`branchId` TEXT NOT NULL, " +
                        "`sku` TEXT NOT NULL, " +
                        "`name` TEXT NOT NULL, " +
                        "`quantity` REAL NOT NULL, " +
                        "`updatedAtEpochMs` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`productId`, `branchId`))",
                )
            }
        }

        fun build(context: Context): KioskDatabase =
            Room.databaseBuilder(context, KioskDatabase::class.java, "kiosk-erp.db")
                .addMigrations(MIGRATION_1_2)
                .fallbackToDestructiveMigrationOnDowngrade()
                .build()
    }
}
