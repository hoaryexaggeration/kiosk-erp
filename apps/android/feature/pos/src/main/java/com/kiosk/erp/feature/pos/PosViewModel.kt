package com.kiosk.erp.feature.pos

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.data.repository.CartLine
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.ProductEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class PosViewModel(
    private val saleRepository: SaleRepository,
    private val productRepository: ProductRepository,
    private val sessionStore: SessionStore,
) : ViewModel() {

    val products: StateFlow<List<ProductEntity>> = productRepository.observeProducts()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _cart = MutableStateFlow<List<CartLine>>(emptyList())
    val cart: StateFlow<List<CartLine>> = _cart

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun totals(): Pricing.DocumentTotals =
        Pricing.computeDocument(_cart.value.map { Pricing.LineInput(it.unitPriceMinor, it.quantity, it.discountBp, it.taxRateBp, it.taxInclusive) })

    fun addProduct(product: ProductEntity) {
        _cart.update { current ->
            val index = current.indexOfFirst { it.productId == product.id }
            if (index >= 0) {
                current.toMutableList().also { it[index] = it[index].copy(quantity = it[index].quantity + 1) }
            } else {
                current + CartLine(product.id, product.sku, product.name, product.unit, 1.0, product.priceMinor, 0, product.taxRateBp, product.taxInclusive)
            }
        }
    }

    fun addTestItem() {
        _cart.update { it + CartLine(null, "CUSTOM", "Custom item", "ea", 1.0, 1000, 0, 1600, true) }
    }

    /**
     * Resolve a scanned (or manually entered) barcode against the LOCAL cache and add it to the cart.
     * Fully offline: an unknown code is reported, never queued as a guess.
     */
    fun onBarcode(code: String) {
        if (code.isBlank()) return
        viewModelScope.launch {
            val product = productRepository.findByBarcode(code)
            if (product == null) {
                _message.value = "No product matches barcode $code — refresh the catalogue if it is new."
            } else {
                addProduct(product)
                _message.value = "Added ${product.name}"
            }
        }
    }

    fun removeAt(index: Int) {
        _cart.update { current -> current.filterIndexed { i, _ -> i != index } }
    }

    fun clearCart() {
        _cart.value = emptyList()
    }

    fun checkout(onDone: (String) -> Unit) {
        viewModelScope.launch {
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            if (_cart.value.isEmpty()) {
                _message.value = "Cart is empty"
                return@launch
            }
            val result = saleRepository.createCashSale(null, _cart.value, branchId, deviceId)
            _message.value = "Saved on this device: ${result.localNumber} • ${Pricing.formatMinor(result.totalMinor)} KES (waiting to sync)"
            _cart.value = emptyList()
            onDone(result.localNumber)
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
