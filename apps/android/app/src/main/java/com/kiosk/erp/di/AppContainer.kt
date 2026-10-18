package com.kiosk.erp.di

import android.content.Context
import com.kiosk.erp.data.local.KioskDatabase
import com.kiosk.erp.data.remote.ApiClient
import com.kiosk.erp.data.repository.InventoryRepository
import com.kiosk.erp.data.repository.SaleRepository
import com.kiosk.erp.data.session.SessionStore
import com.kiosk.erp.sync.SyncEngine

/** Manual dependency container (keeps the MVP free of a DI framework). */
class AppContainer(context: Context) {
    val database: KioskDatabase = KioskDatabase.build(context)
    val sessionStore: SessionStore = SessionStore(context)
    val api: ApiClient = ApiClient()
    val saleRepository: SaleRepository = SaleRepository(database)
    val inventoryRepository: InventoryRepository = InventoryRepository(database)
    val syncEngine: SyncEngine = SyncEngine(database, api, sessionStore, saleRepository)
}
