package com.kiosk.erp.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.kiosk.erp.di.AppContainer
import com.kiosk.erp.feature.catalog.CatalogViewModel
import com.kiosk.erp.feature.dashboard.DashboardViewModel
import com.kiosk.erp.feature.inventory.InventoryViewModel
import com.kiosk.erp.feature.license.LicenseViewModel
import com.kiosk.erp.feature.pos.PosViewModel
import com.kiosk.erp.feature.settings.SettingsViewModel
import com.kiosk.erp.feature.sync.SyncViewModel

/**
 * Wires feature ViewModels to their collaborators. This is the only place that knows both the
 * composition root and the feature ViewModels, which keeps the dependency direction inward (§5).
 */
@Suppress("UNCHECKED_CAST")
class KioskViewModelFactory(private val container: AppContainer) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T = when {
        modelClass.isAssignableFrom(DashboardViewModel::class.java) ->
            DashboardViewModel(container.saleRepository)
        modelClass.isAssignableFrom(PosViewModel::class.java) ->
            PosViewModel(container.saleRepository, container.productRepository, container.sessionStore)
        modelClass.isAssignableFrom(CatalogViewModel::class.java) ->
            CatalogViewModel(container.productRepository, container.api, container.sessionStore)
        modelClass.isAssignableFrom(InventoryViewModel::class.java) ->
            InventoryViewModel(container.inventoryRepository, container.productRepository, container.api, container.sessionStore)
        modelClass.isAssignableFrom(SyncViewModel::class.java) ->
            SyncViewModel(container.syncEngine, container.saleRepository, container.sessionStore)
        modelClass.isAssignableFrom(LicenseViewModel::class.java) ->
            LicenseViewModel()
        modelClass.isAssignableFrom(SettingsViewModel::class.java) ->
            SettingsViewModel(container.api, container.sessionStore, container.saleRepository)
        else -> throw IllegalArgumentException("Unknown ViewModel: ${modelClass.name}")
    } as T
}
