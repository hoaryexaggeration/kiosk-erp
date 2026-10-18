package com.kiosk.erp.di

import android.content.Context
import com.kiosk.erp.BuildConfig
import com.kiosk.erp.core.data.repository.InventoryRepository
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.data.sync.SyncEngine
import com.kiosk.erp.core.database.KioskDatabase
import com.kiosk.erp.core.network.ApiClient

/**
 * Composition root for the application module. Feature modules never see this: they receive the
 * specific collaborators they need, so dependencies point inward (§5 dependency direction).
 */
class AppContainer(context: Context) {
    val database: KioskDatabase = KioskDatabase.build(context)
    val sessionStore: SessionStore = SessionStore(context, BuildConfig.DEFAULT_API_BASE_URL)
    val api: ApiClient = ApiClient()

    val saleRepository: SaleRepository = SaleRepository(database)
    val productRepository: ProductRepository = ProductRepository(database)
    val inventoryRepository: InventoryRepository = InventoryRepository(database)

    val syncEngine: SyncEngine = SyncEngine(database, api, sessionStore, productRepository, inventoryRepository)
}
