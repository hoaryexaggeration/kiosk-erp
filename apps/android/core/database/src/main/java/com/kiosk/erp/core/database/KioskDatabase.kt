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
        ProductPriceOverrideEntity::class,
        SaleEntity::class,
        SaleLineEntity::class,
        TenderEntity::class,
        OutboxEntity::class,
        SyncStateEntity::class,
        StockBalanceEntity::class,
        StockTransferEntity::class,
        StockTransferLineEntity::class,
        BranchEntity::class,
        CashSessionEntity::class,
    ],
    version = 8,
    exportSchema = false,
)
abstract class KioskDatabase : RoomDatabase() {
    abstract fun productDao(): ProductDao
    abstract fun saleDao(): SaleDao
    abstract fun outboxDao(): OutboxDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun inventoryDao(): InventoryDao
    abstract fun transferDao(): TransferDao
    abstract fun branchDao(): BranchDao
    abstract fun cashSessionDao(): CashSessionDao

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
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8)
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

        /**
         * v4 → v5 (item 4.7): cross-branch transfers and the branch list a transfer's destination is
         * picked from. All three tables are new, so nothing existing moves — a device upgrading with
         * queued sales or unsynced adjustments in the outbox keeps them, and its first transfer list
         * arrives as an empty cache rather than a fabricated one.
         */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `branches` (" +
                        "`id` TEXT NOT NULL, " +
                        "`code` TEXT NOT NULL, " +
                        "`name` TEXT NOT NULL, " +
                        "PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `stock_transfers` (" +
                        "`id` TEXT NOT NULL, " +
                        "`reference` TEXT NOT NULL, " +
                        "`fromBranchId` TEXT NOT NULL, " +
                        "`toBranchId` TEXT NOT NULL, " +
                        "`fromBranchName` TEXT NOT NULL, " +
                        "`toBranchName` TEXT NOT NULL, " +
                        "`status` TEXT NOT NULL, " +
                        "`note` TEXT, " +
                        "`approvalNote` TEXT, " +
                        "`dispatchedAt` TEXT NOT NULL, " +
                        "`receivedAt` TEXT, " +
                        "`lineCount` INTEGER NOT NULL, " +
                        "`inTransitQuantity` REAL NOT NULL, " +
                        "`shortageQuantity` REAL NOT NULL, " +
                        "`synced` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `stock_transfer_lines` (" +
                        "`transferId` TEXT NOT NULL, " +
                        "`productId` TEXT NOT NULL, " +
                        "`sku` TEXT NOT NULL, " +
                        "`name` TEXT NOT NULL, " +
                        "`unit` TEXT NOT NULL, " +
                        "`enteredUnit` TEXT, " +
                        "`enteredQuantity` REAL, " +
                        "`dispatched` REAL NOT NULL, " +
                        "`received` REAL, " +
                        "`unitCostMinor` INTEGER NOT NULL, " +
                        "`shortage` REAL NOT NULL, " +
                        "PRIMARY KEY(`transferId`, `productId`))",
                )
            }
        }

        /**
         * v5 → v6 carries the low-stock threshold (item 4.9) on the cached product, so the Stock
         * screen can flag a breached shelf from its own cache while the phone is offline.
         */
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `products` ADD COLUMN `reorderPoint` REAL")
            }
        }

        /**
         * v6 → v7 carries the price LISTS (item 4.11): the base price's version (which price did I
         * charge) and the dated, branch-scoped rows a till prices itself from, offline.
         */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `products` ADD COLUMN `priceVersion` INTEGER NOT NULL DEFAULT 1")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `product_price_overrides` (" +
                        "`id` TEXT NOT NULL, " +
                        "`productId` TEXT NOT NULL, " +
                        "`branchId` TEXT, " +
                        "`branchName` TEXT, " +
                        "`priceMinor` INTEGER NOT NULL, " +
                        "`validFromEpochMs` INTEGER NOT NULL, " +
                        "`validToEpochMs` INTEGER, " +
                        "PRIMARY KEY(`id`))",
                )
            }
        }

        /**
         * v7 → v8 carries the DRAWER (item 5.2, D10). The till cannot sell without an open
         * session, and it opens and closes here first — offline — before the same facts travel
         * as commands the server referees (one drawer per branch; the count is a reading).
         */
        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `cash_sessions` (" +
                        "`id` TEXT NOT NULL, " +
                        "`branchId` TEXT NOT NULL, " +
                        "`deviceId` TEXT NOT NULL, " +
                        "`state` TEXT NOT NULL, " +
                        "`openingFloatMinor` INTEGER NOT NULL, " +
                        "`expectedMinor` INTEGER, " +
                        "`countedMinor` INTEGER, " +
                        "`varianceMinor` INTEGER, " +
                        "`openedAtEpochMs` INTEGER NOT NULL, " +
                        "`closedAtEpochMs` INTEGER, " +
                        "PRIMARY KEY(`id`))",
                )
            }
        }
    }
}
