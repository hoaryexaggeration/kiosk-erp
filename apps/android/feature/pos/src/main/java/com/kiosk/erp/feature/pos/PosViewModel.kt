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

/** A transient message for the cashier: `isError` decides whether it reads as a problem or a result. */
data class PosNotice(val text: String, val isError: Boolean = false)

class PosViewModel(
    private val saleRepository: SaleRepository,
    private val productRepository: ProductRepository,
    private val sessionStore: SessionStore,
) : ViewModel() {

    /**
     * Every cached product, including inactive ones. The screen filters on `isActive`: a deactivated
     * product stays in the catalogue for history but must never be sellable at the till.
     */
    val products: StateFlow<List<ProductEntity>> = productRepository.observeProducts()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _cart = MutableStateFlow<List<CartLine>>(emptyList())
    val cart: StateFlow<List<CartLine>> = _cart

    private val _notice = MutableStateFlow<PosNotice?>(null)
    val notice: StateFlow<PosNotice?> = _notice

    fun totals(): Pricing.DocumentTotals =
        Pricing.computeDocument(_cart.value.map { Pricing.LineInput(it.unitPriceMinor, it.quantity, it.discountBp, it.taxRateBp, it.taxInclusive) })

    fun addProduct(product: ProductEntity) {
        if (!product.isActive) {
            _notice.value = PosNotice("${product.name} is deactivated and cannot be sold", isError = true)
            return
        }
        _cart.update { current ->
            val index = current.indexOfFirst { it.productId == product.id }
            if (index >= 0) {
                current.toMutableList().also { it[index] = it[index].copy(quantity = it[index].quantity + 1) }
            } else {
                current + CartLine(product.id, product.sku, product.name, product.unit, 1.0, product.priceMinor, 0, product.taxRateBp, product.taxInclusive)
            }
        }
        _notice.value = PosNotice("Added ${product.name}")
    }

    /**
     * Resolve a scanned (or manually entered) barcode against the LOCAL cache and add it to the cart.
     * Fully offline: an unknown code is reported, never queued as a guess. `onOutcome(true)` means the
     * code was resolved and the scanner should close.
     */
    fun onBarcode(code: String, onOutcome: (Boolean) -> Unit) {
        if (code.isBlank()) {
            onOutcome(false)
            return
        }
        viewModelScope.launch {
            val product = productRepository.findByBarcode(code)
            when {
                product == null -> {
                    _notice.value = PosNotice("No product matches barcode $code — refresh the catalogue if it is new.", isError = true)
                    onOutcome(false)
                }
                !product.isActive -> {
                    _notice.value = PosNotice("${product.name} is deactivated and cannot be sold", isError = true)
                    onOutcome(false)
                }
                else -> {
                    addProduct(product)
                    onOutcome(true)
                }
            }
        }
    }

    /** Step a line's quantity. Clamped at one: deleting a line is the remove button's job, so a
     *  double-tap on "−" can never silently drop an item the cashier meant to keep. */
    fun changeQuantity(index: Int, step: Int) {
        _cart.update { current ->
            if (index !in current.indices) return@update current
            val line = current[index]
            val next = (line.quantity + step).coerceAtLeast(1.0)
            current.toMutableList().also { it[index] = line.copy(quantity = next) }
        }
    }

    fun removeLine(index: Int) {
        val name = _cart.value.getOrNull(index)?.name
        _cart.update { current -> current.filterIndexed { i, _ -> i != index } }
        if (name != null) _notice.value = PosNotice("Removed $name")
    }

    fun clearCart() {
        _cart.value = emptyList()
        _notice.value = PosNotice("Cart cleared")
    }

    fun clearNotice() {
        _notice.value = null
    }

    fun checkout(onDone: (String) -> Unit) {
        viewModelScope.launch {
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            if (_cart.value.isEmpty()) {
                _notice.value = PosNotice("The cart is empty — scan or search for an item first.", isError = true)
                return@launch
            }
            val result = saleRepository.createCashSale(null, _cart.value, branchId, deviceId)
            _notice.value = PosNotice(
                "Receipt ${result.localNumber} · ${Pricing.formatMinor(result.totalMinor)} KES saved on this device. It uploads when the connection is back.",
            )
            _cart.value = emptyList()
            onDone(result.localNumber)
        }
    }
}
