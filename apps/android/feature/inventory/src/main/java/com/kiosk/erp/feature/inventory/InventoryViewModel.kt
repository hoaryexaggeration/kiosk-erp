package com.kiosk.erp.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.InventoryRepository
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.database.StockBalanceEntity
import com.kiosk.erp.core.network.ApiClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class InventoryViewModel(
    private val inventoryRepository: InventoryRepository,
    productRepository: ProductRepository,
    private val api: ApiClient,
    private val sessionStore: SessionStore,
) : ViewModel() {

    val balances: StateFlow<List<StockBalanceEntity>> = inventoryRepository.observeBalances()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val products: StateFlow<List<ProductEntity>> = productRepository.observeProducts()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun refresh() {
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _message.value = "Sign in first (Settings) to pull stock"
                return@launch
            }
            runCatching { api.inventoryBalances(session.apiBaseUrl, session.accessToken!!) }
                .onSuccess {
                    inventoryRepository.cacheBalances(it)
                    _message.value = "Refreshed ${it.size} balances from server"
                }
                .onFailure { _message.value = "Refresh failed: ${it.message}" }
        }
    }

    /** Queue an adjustment offline. Reason is required; the movement posts on the next sync. */
    fun adjust(product: ProductEntity, quantityDelta: Double, reason: String) {
        viewModelScope.launch {
            if (quantityDelta == 0.0) {
                _message.value = "Enter a non-zero quantity delta"
                return@launch
            }
            if (reason.isBlank()) {
                _message.value = "A reason is required for an adjustment"
                return@launch
            }
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            inventoryRepository.createAdjustment(product.id, product.sku, product.name, quantityDelta, reason.trim(), branchId, deviceId)
            _message.value = "Queued ${if (quantityDelta > 0) "+" else ""}$quantityDelta ${product.sku} • waiting to sync"
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
