package com.kiosk.erp.feature.catalog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.network.ApiClient
import com.kiosk.erp.core.network.ApiException
import com.kiosk.erp.core.network.ImportReport
import com.kiosk.erp.core.network.ImportSource
import com.kiosk.erp.core.network.ProductDraft
import com.kiosk.erp.core.network.ServerBrand
import com.kiosk.erp.core.network.ServerCategory
import com.kiosk.erp.core.network.ServerConversion
import com.kiosk.erp.core.network.ServerTaxCategory
import com.kiosk.erp.core.network.ServerUnit
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
    val brandId: String? = null,
    val unit: String = "ea",
    val priceText: String = "",
    val costText: String = "",
    val isStockTracked: Boolean = true,
    val isActive: Boolean = true,
    val expectedVersion: Int? = null,
    val barcodes: List<String> = emptyList(),
    val newBarcode: String = "",
    /** Pack sizes this product may be written in (item 4.6): 1 crate = 24 of the unit above. */
    val conversions: List<ServerConversion> = emptyList(),
    val newConversionUnit: String = "",
    val newConversionFactor: String = "",
    val error: String? = null,
    val saving: Boolean = false,
) {
    val isNew: Boolean get() = id == null
    val title: String get() = if (isNew) "New product" else "Edit product"
    /** Live, exact validity so the save button can be disabled rather than failing on submit. */
    val priceMinor: Long? get() = Pricing.parseMinorInput(priceText)
    val costMinor: Long? get() = if (costText.isBlank()) 0L else Pricing.parseMinorInput(costText)
    val canSave: Boolean get() = !saving && sku.isNotBlank() && name.isNotBlank() && priceMinor != null && costMinor != null
    /** What a pack row reads: `1 crate = 24 ea`. */
    fun conversionLabel(conversion: ServerConversion): String = "1 ${conversion.unit} = ${Units.formatQuantity(conversion.factor)} $unit"
}

/** Reference data the editor needs (categories, tax rates, brands and units), refreshed from the server. */
data class CatalogMeta(
    val categories: List<ServerCategory> = emptyList(),
    val taxCategories: List<ServerTaxCategory> = emptyList(),
    val units: List<ServerUnit> = emptyList(),
    val brands: List<ServerBrand> = emptyList(),
    val loading: Boolean = false,
    val online: Boolean = true,
    val message: String? = null,
)

/**
 * A bulk import in progress. The file text is held as it arrived — not re-serialised — so what the
 * server validates in the preview is byte-for-byte what a commit sends. Toggling
 * `createMissingCategories` or `createMissingBrands` re-runs the preview, because each changes which
 * rows are valid and the operator must approve the same report that the commit will act on.
 */
data class ImportState(
    val fileName: String,
    val source: ImportSource,
    val report: ImportReport? = null,
    val analysing: Boolean = false,
    val committing: Boolean = false,
    val error: String? = null,
    val createMissingCategories: Boolean = false,
    val createMissingBrands: Boolean = false,
)

/** One round-trip of reference data for `loadMeta` — fetched together so the vocabulary is complete. */
private data class ReferenceData(
    val categories: List<ServerCategory>,
    val taxCategories: List<ServerTaxCategory>,
    val units: List<ServerUnit>,
    val brands: List<ServerBrand>,
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

    private val _import = MutableStateFlow<ImportState?>(null)
    val importState: StateFlow<ImportState?> = _import.asStateFlow()

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
                // Units and brands travel with categories and tax rates (item 4.6): the editor and the
                // stock screen resolve a pack size from these, so they must arrive together or an
                // offline device has a half-complete vocabulary to work in.
                val base = session.apiBaseUrl
                val token = session.accessToken!!
                ReferenceData(
                    categories = api.categories(base, token),
                    taxCategories = api.taxCategories(base, token),
                    units = api.units(base, token),
                    brands = api.brands(base, token),
                )
            }
                .onSuccess { fresh ->
                    _meta.value = _meta.value.copy(
                        categories = fresh.categories,
                        taxCategories = fresh.taxCategories,
                        units = fresh.units,
                        brands = fresh.brands,
                        loading = false,
                        online = true,
                    )
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
     * Seed the editor from the cached product AND its cached barcode set and pack sizes, so saving
     * cannot silently drop the tags or conversions that are already on the item. Reading Room is a
     * suspend call, so the editor opens once it has the complete picture rather than briefly showing
     * an empty set that could be saved.
     */
    fun openForEdit(product: ProductEntity) {
        viewModelScope.launch {
            val barcodes = productRepository.barcodes(product.id)
            val conversions = productRepository.conversions(product.id)
            _editor.value = ProductEditorState(
                id = product.id,
                sku = product.sku,
                name = product.name,
                description = product.description ?: "",
                categoryId = product.categoryId,
                taxCategoryId = product.taxCategoryId,
                brandId = product.brandId,
                unit = product.unit,
                priceText = Pricing.formatMinor(product.priceMinor),
                costText = Pricing.formatMinor(product.costMinor),
                isStockTracked = product.isStockTracked,
                isActive = product.isActive,
                expectedVersion = product.version,
                barcodes = barcodes,
                conversions = conversions.map { ServerConversion(unit = it.unit, factor = it.factor) },
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

    // --- pack sizes (item 4.6) -------------------------------------------------------------------

    /**
     * Add (or restate) a pack size. The same three refusals the server makes, made here first so the
     * operator is told at the field rather than after a round-trip: an unknown unit, a pack that
     * converts the unit into itself, and a factor that could not describe one.
     */
    fun addConversion() {
        val current = _editor.value ?: return
        val unit = current.newConversionUnit.trim()
        val factorText = current.newConversionFactor.trim()
        if (unit.isEmpty() || factorText.isEmpty()) return

        val fail: (String) -> Unit = { message -> _editor.value = current.copy(error = message) }
        if (unit.equals(current.unit, ignoreCase = true)) {
            fail("\"$unit\" is already the unit this product sells in — a pack size converts a different unit into it")
            return
        }
        val known = _meta.value.units.any { it.code.equals(unit, ignoreCase = true) }
        if (_meta.value.units.isNotEmpty() && !known) {
            fail("There is no unit \"$unit\" — add it under Manage first (item 4.6)")
            return
        }
        if (_meta.value.units.isNotEmpty() && _meta.value.units.none { it.code.equals(current.unit, ignoreCase = true) }) {
            fail("Selling unit \"${current.unit}\" is not in the unit list either — add it under Manage before giving the product pack sizes")
            return
        }
        val factor = factorText.toDoubleOrNull()
        if (factor == null || !factor.isFinite() || factor <= 0.0) {
            fail("How many ${current.unit}s make one $unit? That number must be more than zero")
            return
        }

        // A set, not a list: restating a pack replaces it, and the save sends the whole set.
        val rest = current.conversions.filterNot { it.unit.equals(unit, ignoreCase = true) }
        _editor.value = current.copy(
            conversions = (rest + ServerConversion(unit = unit, factor = factor)).sortedBy { it.unit.lowercase() },
            newConversionUnit = "",
            newConversionFactor = "",
            error = null,
        )
    }

    fun removeConversion(unit: String) {
        _editor.value = _editor.value?.let { state ->
            state.copy(conversions = state.conversions.filterNot { it.unit.equals(unit, ignoreCase = true) })
        }
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
                brandId = editor.brandId,
                unit = editor.unit.trim().ifBlank { "ea" },
                priceMinor = priceMinor,
                costMinor = costMinor,
                isStockTracked = editor.isStockTracked,
                isActive = editor.isActive,
                barcodes = editor.barcodes,
                conversions = editor.conversions,
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
            // Both sets travel with the change: the update replaces what the server holds, so sending
            // an empty pack set here would quietly retire every crate size on the item (item 4.6).
            val draft = ProductDraft(
                id = product.id,
                sku = product.sku,
                name = product.name,
                description = product.description,
                categoryId = product.categoryId,
                taxCategoryId = product.taxCategoryId,
                brandId = product.brandId,
                unit = product.unit,
                priceMinor = product.priceMinor,
                costMinor = product.costMinor,
                isStockTracked = product.isStockTracked,
                isActive = active,
                barcodes = productRepository.barcodes(product.id),
                conversions = productRepository.conversions(product.id)
                    .map { ServerConversion(unit = it.unit, factor = it.factor) },
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

    // --- units of measure and brands (item 4.6) ---------------------------------------------------

    /** `kind` decides what a quantity in this unit may be: a count stays whole, a weight may not. */
    fun createUnit(code: String, name: String, kind: String) {
        if (code.isBlank() || name.isBlank()) return
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(message = "Sign in first (Setup)")
                return@launch
            }
            runCatching { api.createUnit(session.apiBaseUrl, session.accessToken!!, code.trim(), name.trim(), kind) }
                .onSuccess { created ->
                    _meta.value = _meta.value.copy(
                        units = (_meta.value.units + created).sortedBy { it.code.lowercase() },
                        message = "Unit \"${created.code}\" added",
                    )
                }
                .onFailure { _meta.value = _meta.value.copy(message = "Failed: ${describe(it)}") }
        }
    }

    fun createBrand(name: String) {
        if (name.isBlank()) return
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _meta.value = _meta.value.copy(message = "Sign in first (Setup)")
                return@launch
            }
            runCatching { api.createBrand(session.apiBaseUrl, session.accessToken!!, name.trim()) }
                .onSuccess { created ->
                    _meta.value = _meta.value.copy(brands = (_meta.value.brands + created).sortedBy { it.name.lowercase() }, message = "Brand \"${created.name}\" added")
                }
                .onFailure { _meta.value = _meta.value.copy(message = "Failed: ${describe(it)}") }
        }
    }

    // --- bulk import (item 4.4) ------------------------------------------------------------------

    /** The file is validated by the SERVER, so a preview here is the real thing, not a local guess. */
    fun analyseImport(fileName: String, text: String) {
        _import.value = ImportState(fileName = fileName, source = ImportSource.detect(fileName, text))
        runImport(commit = false)
    }

    fun setImportCreateMissingCategories(value: Boolean) {
        val current = _import.value ?: return
        _import.value = current.copy(createMissingCategories = value)
        runImport(commit = false)
    }

    /** Brands are labels too, but an invented one is still an invented one — the operator decides. */
    fun setImportCreateMissingBrands(value: Boolean) {
        val current = _import.value ?: return
        _import.value = current.copy(createMissingBrands = value)
        runImport(commit = false)
    }

    fun commitImport() {
        runImport(commit = true)
    }

    fun cancelImport() {
        _import.value = null
    }

    fun importReadFailed() {
        _meta.value = _meta.value.copy(message = "Could not read that file")
    }

    private fun runImport(commit: Boolean) {
        val current = _import.value ?: return
        viewModelScope.launch {
            _import.value = current.copy(analysing = !commit, committing = commit, error = null)
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _import.value = current.copy(analysing = false, committing = false, error = "Sign in first (Setup) to import a catalogue")
                return@launch
            }
            runCatching {
                api.importProducts(
                    session.apiBaseUrl,
                    session.accessToken!!,
                    current.source,
                    commit,
                    current.createMissingCategories,
                    current.createMissingBrands,
                )
            }
                .onSuccess { report ->
                    if (commit && report.isValid) {
                        // Refresh the cache so the imported products are visible and scannable straight away.
                        runCatching { api.serverProducts(session.apiBaseUrl, session.accessToken!!) }
                            .onSuccess { productRepository.refreshProducts(it) }
                        _import.value = null
                        _meta.value = _meta.value.copy(
                            message = "Imported ${report.createCount} new and ${report.updateCount} updated products",
                            online = true,
                        )
                    } else {
                        _import.value = current.copy(report = report, analysing = false, committing = false)
                    }
                }
                .onFailure { failure ->
                    _import.value = current.copy(analysing = false, committing = false, error = describe(failure))
                }
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
            "INVALID_IMPORT_FILE" -> detail
            // Unit and pack-size refusals (item 4.6): the server's sentence already names the unit,
            // the factor or the product, which is exactly what an operator needs to fix the field.
            "UNKNOWN_UNIT" -> "That unit is not in this shop's unit list — add it under Manage first"
            "DUPLICATE_UNIT" -> "That unit already exists"
            "DUPLICATE_BRAND" -> "That brand already exists"
            "UNKNOWN_UNIT_KIND" -> detail
            "SELF_CONVERSION", "UNKNOWN_CONVERSION", "UNKNOWN_BRAND", "INVALID_BRAND" -> detail
            "INVALID_FACTOR", "INVALID_CONVERSION_FACTOR", "FRACTIONAL_QUANTITY" -> detail
            null -> "Could not reach the server ($detail)"
            else -> "$detail (${api.code})"
        }
    }
}
