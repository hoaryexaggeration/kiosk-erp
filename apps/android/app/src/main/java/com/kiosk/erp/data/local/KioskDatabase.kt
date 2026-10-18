package com.kiosk.erp.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

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
    ],
    version = 1,
    exportSchema = false,
)
abstract class KioskDatabase : RoomDatabase() {
    abstract fun productDao(): ProductDao
    abstract fun saleDao(): SaleDao
    abstract fun outboxDao(): OutboxDao
    abstract fun syncStateDao(): SyncStateDao

    companion object {
        fun build(context: Context): KioskDatabase =
            Room.databaseBuilder(context, KioskDatabase::class.java, "kiosk-erp.db")
                .fallbackToDestructiveMigrationOnDowngrade()
                .build()
    }
}
