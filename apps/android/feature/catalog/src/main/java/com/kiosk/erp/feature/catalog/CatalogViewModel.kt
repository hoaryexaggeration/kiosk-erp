package com.kiosk.erp.feature.catalog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.network.ApiClient
import com.kiosk.erp.core.network.ApiException
import com.kiosk.erp.core.network.ProductDraft
import com.kiosk.erp.core.network.ServerCategory
import com.kiosk.erp.core.network.ServerTaxCategory
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * A product being edited. Money is held as the operator TYPED it and parsed exactly on save, so a
 * typed price never round-trips through a Double.
 */
data class ProductEditorState(
    val id: String? = null,
    val sku: String = "",
    val name: String = "",
    val description: String = "",
    val categoryId: String? = null,
    val taxCategoryId: String? = null,
    val unit: String = "ea",
    val priceText: String = "",
    val costText: String = "",
    val isStockTracked: Boolean = true,
    val isActive: Boolean = true,
    val expectedVersion: Int? = null,
    val barcodes: List<String> = emptyList(),
    val newBarcode: String = "",
    val error: String? = null,
    val saving: Boolean = false,
) {
    val isNew: Boolean get() = id == null
    val title: String get() = if (isNew) "New product" else "Edit product"
    /** Live, exact validity so the save button can be disabled rather than failing on submit. */
    val priceMinor: Long? get() = Pricing.parseMinorInput(priceText)
    val costMinor: Long? get() = if (costText.isBlank()) 0L else Pricing.parseMinorInput(costText)
    val canSave: Boolean get() = !saving && sku.isNotBlank() && name.isNotBlank() && priceMinor != null && costMinor != null
}

/** Reference data the editor needs (categories and tax rates), refreshed from the server. */
data class CatalogMeta(
    val categories: List<ServerCategory> = emptyList(),
    val taxCategories: List<ServerTaxCategory> = emptyList(),
    val loading: Boolean = false,
    val online: Boolean = true,
    val message: String? = null,
)

@OptIn(ExperimentalCoroutinesApi::class, FlowPreview::class)
class CatalogViewModel(
    private val productRepository: ProductRepository,
    private val api: ApiClient,
    private val sessionStore: SessionStore,
) : ViewModel() {

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    val products: StateFlow<List<ProductEntity>> = _query
        .debounce(150)
        .flatMapLatest { productRepository.observeMatching(it) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _meta = MutableStateFlow(CatalogMeta())
    val meta: StateFlow<CatalogMeta> = _meta.asStateFlow()

    private val _editor = MutableStateFlow<ProductEditorState?>(null)
    val editor: StateFlow<ProductEditorState?> = _editor.asStateFlow()

    init {
        loadMeta()
    }

    fun setQuery(value: String) {
        _query.value = value
    }

    fun loadMeta() {
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(online = false)
                return@launch
            }
            _meta.value = _meta.value.copy(loading = true)
            runCatching {
                val cats = api.categories(session.apiBaseUrl, session.accessToken!!)
                val taxes = api.taxCategories(session.apiBaseUrl, session.accessToken!!)
                cats to taxes
            }
                .onSuccess { (cats, taxes) ->
                    _meta.value = _meta.value.copy(categories = cats, taxCategories = taxes, loading = false, online = true)
                }
                .onFailure {
                    // Offline is a normal state, not an error: the list still works from the cache.
                    _meta.value = _meta.value.copy(loading = false, online = false)
                }
        }
    }

    /** Push the catalogue down to the device again (offline reads are then complete). */
    fun refreshFromServer() {
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(message = "Sign in first (Setup) to refresh the catalogue")
                return@launch
            }
            runCatching { api.serverProducts(session.apiBaseUrl, session.accessToken!!) }
                .onSuccess { list ->
                    productRepository.refreshProducts(list)
                    _meta.value = _meta.value.copy(message = "Cached ${list.size} products for offline use", online = true)
                }
                .onFailure { _meta.value = _meta.value.copy(message = "Refresh failed: ${it.message}", online = false) }
        }
    }

    fun clearMessage() {
        _meta.value = _meta.value.copy(message = null)
    }

    // --- editor ----------------------------------------------------------------------------------

    fun openNew() {
        _editor.value = ProductEditorState(taxCategoryId = _meta.value.taxCategories.firstOrNull()?.id)
    }

    /**
     * Seed the editor from the cached product AND its cached barcode set, so saving cannot silently
     * drop the tags that are already on the item. Reading Room is a suspend call, so the editor opens
     * once it has the complete picture rather than briefly showing an empty set that could be saved.
     */
    fun openForEdit(product: ProductEntity) {
        viewModelScope.launch {
            val barcodes = productRepository.barcodes(product.id)
            _editor.value = ProductEditorState(
                id = product.id,
                sku = product.sku,
                name = product.name,
                description = product.description ?: "",
                categoryId = product.categoryId,
                taxCategoryId = product.taxCategoryId,
                unit = product.unit,
                priceText = Pricing.formatMinor(product.priceMinor),
                costText = Pricing.formatMinor(product.costMinor),
                isStockTracked = product.isStockTracked,
                isActive = product.isActive,
                expectedVersion = product.version,
                barcodes = barcodes,
            )
        }
    }

    fun closeEditor() {
        _editor.value = null
    }

    fun edit(transform: (ProductEditorState) -> ProductEditorState) {
        _editor.value = _editor.value?.let { transform(it).copy(error = null) }
    }

    fun addBarcode() {
        val current = _editor.value ?: return
        val code = current.newBarcode.trim()
        if (code.isEmpty()) return
        if (current.barcodes.any { it.equals(code, ignoreCase = true) }) {
            _editor.value = current.copy(newBarcode = "", error = "That barcode is already on this product")
            return
        }
        _editor.value = current.copy(barcodes = current.barcodes + code, newBarcode = "")
    }

    fun removeBarcode(code: String) {
        _editor.value = _editor.value?.let { it.copy(barcodes = it.barcodes.filterNot { b -> b == code }) }
    }

    fun save() {
        val editor = _editor.value ?: return
        val priceMinor = editor.priceMinor
        val costMinor = editor.costMinor
        if (!editor.canSave || priceMinor == null || costMinor == null) {
            _editor.value = editor.copy(error = "Check the SKU, name and price (two decimals at most)")
            return
        }
        viewModelScope.launch {
            _editor.value = editor.copy(saving = true, error = null)
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _editor.value = editor.copy(saving = false, error = "Sign in first (Setup) to change the catalogue")
                return@launch
            }
            val draft = ProductDraft(
                id = editor.id,
                sku = editor.sku.trim(),
                name = editor.name.trim(),
                description = editor.description.trim().ifBlank { null },
                categoryId = editor.categoryId,
                taxCategoryId = editor.taxCategoryId,
                unit = editor.unit.trim().ifBlank { "ea" },
                priceMinor = priceMinor,
                costMinor = costMinor,
                isStockTracked = editor.isStockTracked,
                isActive = editor.isActive,
                barcodes = editor.barcodes,
                expectedVersion = editor.expectedVersion,
            )
            runCatching { api.saveProduct(session.apiBaseUrl, session.accessToken!!, draft) }
                .onSuccess { saved ->
                    productRepository.cacheProduct(saved)
                    _editor.value = null
                    _meta.value = _meta.value.copy(message = "${saved.name} saved", online = true)
                }
                .onFailure { failure ->
                    _editor.value = editor.copy(saving = false, error = describe(failure))
                }
        }
    }

    /** Deactivate rather than delete: the item stays on historical sales and receipts. */
    fun setActive(product: ProductEntity, active: Boolean) {
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(message = "Sign in first (Setup) to change the catalogue")
                return@launch
            }
            val draft = ProductDraft(
                id = product.id,
                sku = product.sku,
                name = product.name,
                description = product.description,
                categoryId = product.categoryId,
                taxCategoryId = product.taxCategoryId,
                unit = product.unit,
                priceMinor = product.priceMinor,
                costMinor = product.costMinor,
                isStockTracked = product.isStockTracked,
                isActive = active,
                barcodes = productRepository.barcodes(product.id),
                expectedVersion = product.version,
            )
            runCatching { api.saveProduct(session.apiBaseUrl, session.accessToken!!, draft) }
                .onSuccess { saved ->
                    productRepository.cacheProduct(saved)
                    _meta.value = _meta.value.copy(message = "${saved.name} ${if (active) "reactivated" else "deactivated"}")
                }
                .onFailure { _meta.value = _meta.value.copy(message = "Failed: ${describe(it)}") }
        }
    }

    // --- categories and tax rates (item 4.3) -----------------------------------------------------

    fun createCategory(name: String) {
        if (name.isBlank()) return
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(message = "Sign in first (Setup)")
                return@launch
            }
            runCatching { api.createCategory(session.apiBaseUrl, session.accessToken!!, name.trim()) }
                .onSuccess { created ->
                    _meta.value = _meta.value.copy(categories = _meta.value.categories + created, message = "Category \"${created.name}\" added")
                }
                .onFailure { _meta.value = _meta.value.copy(message = "Failed: ${describe(it)}") }
        }
    }

    /** `ratePercent` is what a shopkeeper knows ("16"); basis points are derived exactly. */
    fun createTaxCategory(name: String, ratePercent: String, inclusive: Boolean) {
        if (name.isBlank()) return
        val rateBp = Pricing.parseMinorInput(ratePercent)
        if (rateBp == null || rateBp > 10000) {
            _meta.value = _meta.value.copy(message = "Tax rate must be a percentage such as 16 or 16.5")
            return
        }
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(message = "Sign in first (Setup)")
                return@launch
            }
            runCatching { api.createTaxCategory(session.apiBaseUrl, session.accessToken!!, name.trim(), rateBp.toInt(), inclusive) }
                .onSuccess { created ->
                    _meta.value = _meta.value.copy(taxCategories = _meta.value.taxCategories + created, message = "Tax rate \"${created.name}\" added")
                }
                .onFailure { _meta.value = _meta.value.copy(message = "Failed: ${describe(it)}") }
        }
    }

    /** Server rejections carry a machine code; translate the ones an operator can act on. */
    private fun describe(failure: Throwable): String {
        val api = failure as? ApiException
        val detail = api?.message ?: failure.message ?: "unknown error"
        return when (api?.code) {
            "DUPLICATE_SKU" -> "That SKU is already used by another product"
            "DUPLICATE_BARCODE" -> "That barcode belongs to another product"
            "VERSION_MISMATCH" -> "Someone else changed this product first — reopen it and try again"
            "FORBIDDEN" -> "Your role cannot change the catalogue"
            null -> "Could not reach the server ($detail)"
            else -> "$detail (${api.code})"
        }
    }
}
