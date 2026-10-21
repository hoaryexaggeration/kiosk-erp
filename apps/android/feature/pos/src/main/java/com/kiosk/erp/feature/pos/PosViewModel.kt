package com.kiosk.erp.feature.pos

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.data.repository.CartLine
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.CashSessionEntity
import com.kiosk.erp.core.database.ProductEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

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

    /**
     * The drawer this till is trading from (item 5.2, D10). Loaded once from Room — the very
     * cache the checkout gate reads — and refreshed by open/close; the server referees the
     * queued commands when the connection returns.
     */
    private val _drawer = MutableStateFlow<CashSessionEntity?>(null)
    val drawer: StateFlow<CashSessionEntity?> = _drawer

    init {
        viewModelScope.launch {
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            _drawer.value = saleRepository.observeOpenSession(branchId).first()
        }
    }

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
        // Name the count and the running total, not just the product: the cashier needs to see that
        // the tap or the scan landed, and by how much, without hunting for a change in a badge.
        val lines = _cart.value.size
        _notice.value = PosNotice(
            "Added ${product.name} · cart $lines item${if (lines == 1) "" else "s"} · ${Pricing.formatMinor(totals().totalMinor)} KES",
        )
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
                    _notice.value = PosNotice(
                        "No product matches barcode $code. Pull the catalogue with Sync, or add the product in Setup → Catalogue.",
                        isError = true,
                    )
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
            // The drawer gate (item 5.2, D10): a sale must belong to an open session, and the
            // server refuses one that does not — so the till says so HERE, at the button, rather
            // than letting a receipt vanish into a rejected sync command.
            val drawer = _drawer.value
            if (drawer == null || drawer.state != "open") {
                _notice.value = PosNotice("Open the drawer first — a sale cannot be recorded without one.", isError = true)
                return@launch
            }
            // The cached role decides what the CASHIER is told; the server re-checks regardless.
            if (!session.has("pos.sale.create")) {
                _notice.value = PosNotice("This user cannot create sales (missing permission pos.sale.create).", isError = true)
                return@launch
            }
            val result = saleRepository.createCashSale(drawer.id, null, _cart.value, branchId, deviceId)
            _notice.value = PosNotice(
                "Receipt ${result.localNumber} · ${Pricing.formatMinor(result.totalMinor)} KES saved on this device. It uploads when the connection is back.",
            )
            _cart.value = emptyList()
            onDone(result.localNumber)
        }
    }

    // --- the drawer (item 5.2, D10) ----------------------------------------------------------------

    /** Open the drawer with its float. Offline-first: the row and its command land locally now. */
    fun openDrawer(openingFloatMinor: Long) {
        viewModelScope.launch {
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            val opened = saleRepository.openSession(
                id = UUID.randomUUID().toString(),
                branchId = branchId,
                deviceId = deviceId,
                openingFloatMinor = openingFloatMinor,
                openedAtEpochMs = System.currentTimeMillis(),
            )
            _drawer.value = opened
            _notice.value = PosNotice("Drawer opened · float ${Pricing.formatMinor(openingFloatMinor)} KES")
        }
    }

    /**
     * Close with what the till physically counted. The count is a reading — it is recorded here
     * and travels as a command; the server derives expected and variance itself when it lands.
     */
    fun closeDrawer(countedMinor: Long) {
        viewModelScope.launch {
            val drawer = _drawer.value ?: return@launch
            saleRepository.closeSession(drawer, countedMinor, System.currentTimeMillis())
            _drawer.value = null
            _notice.value = PosNotice("Drawer closed · counted ${Pricing.formatMinor(countedMinor)} KES · uploads with the next sync")
        }
    }
}
