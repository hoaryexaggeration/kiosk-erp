package com.kiosk.erp.feature.catalog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.network.ApiClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class CatalogViewModel(
    private val productRepository: ProductRepository,
    private val api: ApiClient,
    private val sessionStore: SessionStore,
) : ViewModel() {

    val products: StateFlow<List<ProductEntity>> = productRepository.observeProducts()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun refreshFromServer() {
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _message.value = "Sign in first (Settings) to refresh the catalogue"
                return@launch
            }
            runCatching { api.serverProducts(session.apiBaseUrl, session.accessToken!!) }
                .onSuccess { products ->
                    productRepository.refreshProducts(products)
                    _message.value = "Cached ${products.size} products for offline use"
                }
                .onFailure { _message.value = "Refresh failed: ${it.message}" }
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
