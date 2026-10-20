package com.kiosk.erp.core.database

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
        ProductConversionEntity::class,
        SaleEntity::class,
        SaleLineEntity::class,
        TenderEntity::class,
        OutboxEntity::class,
        SyncStateEntity::class,
        StockBalanceEntity::class,
    ],
    version = 4,
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
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
                .fallbackToDestructiveMigrationOnDowngrade()
                .build()

        /**
         * v2 → v3 carries the catalogue fields the management screen edits (description, category and
         * active flag) so the device can show and edit a complete product without a server round-trip
         * for reads. Additive columns only — existing rows keep their values and default to active.
         */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `products` ADD COLUMN `description` TEXT")
                db.execSQL("ALTER TABLE `products` ADD COLUMN `categoryId` TEXT")
                db.execSQL("ALTER TABLE `products` ADD COLUMN `taxCategoryId` TEXT")
                db.execSQL("ALTER TABLE `products` ADD COLUMN `isActive` INTEGER NOT NULL DEFAULT 1")
            }
        }

        /**
         * v3 → v4 (item 4.6): a brand on the product, its pack sizes as a set, and the `kind` of the
         * base unit those pack sizes convert into — without it an offline device cannot tell a crate
         * count (which must land on a whole number) from a weigh (which may not). All additive: a
         * device upgraded with unsynced sales in the outbox keeps them, nothing is dropped.
         */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `products` ADD COLUMN `brandId` TEXT")
                db.execSQL("ALTER TABLE `products` ADD COLUMN `brandName` TEXT")
                db.execSQL("ALTER TABLE `products` ADD COLUMN `unitKind` TEXT")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `product_conversions` (" +
                        "`productId` TEXT NOT NULL, " +
                        "`unit` TEXT NOT NULL, " +
                        "`factor` REAL NOT NULL, " +
                        "PRIMARY KEY(`productId`, `unit`))",
                )
            }
        }
    }
}
