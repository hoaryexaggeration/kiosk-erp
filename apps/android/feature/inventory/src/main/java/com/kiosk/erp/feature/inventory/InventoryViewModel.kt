package com.kiosk.erp.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.data.repository.InventoryRepository
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.database.StockBalanceEntity
import com.kiosk.erp.core.network.ApiClient
import com.kiosk.erp.core.network.ApiException
import com.kiosk.erp.core.network.ImportSource
import com.kiosk.erp.core.network.OpeningStockReport
import com.kiosk.erp.core.network.ServerMovement
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * The per-product movement ledger as the server reports it. Held in memory only and fetched on
 * demand: history is a server fact, not something the device can reconstruct exactly offline.
 */
data class MovementHistory(
    val product: ProductEntity,
    val movements: List<ServerMovement> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * The opening-stock import in progress (item 4.5). `source == null` means no file has been chosen
 * yet and only the chooser is showing; `requestId` is minted once per file so a preview and its
 * commit are recognised as the same import if the connection drops between them.
 */
data class OpeningImportState(
    val requestId: String,
    val fileName: String = "",
    val source: ImportSource? = null,
    val typedText: String = "",
    val report: OpeningStockReport? = null,
    val analysing: Boolean = false,
    val committing: Boolean = false,
    val error: String? = null,
)

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

    private val _history = MutableStateFlow<MovementHistory?>(null)
    val history: StateFlow<MovementHistory?> = _history.asStateFlow()

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

    // --- opening-stock import (item 4.5) ---------------------------------------------------------

    private val _openingImport = MutableStateFlow<OpeningImportState?>(null)
    val openingImport: StateFlow<OpeningImportState?> = _openingImport.asStateFlow()

    fun openOpeningImport() {
        // A fresh identity per visit: an abandoned preview must never commit against a later file.
        _openingImport.value = OpeningImportState(requestId = UUID.randomUUID().toString())
    }

    fun closeOpeningImport() {
        _openingImport.value = null
    }

    fun clearOpeningError() {
        _openingImport.value = _openingImport.value?.copy(error = null)
    }

    fun openingReadFailed() {
        _openingImport.value = _openingImport.value?.copy(error = "Could not read that file")
    }

    fun setOpeningTypedText(value: String) {
        val current = _openingImport.value ?: return
        // Editing the text invalidates whatever the server last thought of it.
        _openingImport.value = current.copy(typedText = value, report = null, error = null)
    }

    fun analyseOpeningFile(fileName: String, text: String) {
        val current = _openingImport.value ?: return
        _openingImport.value = current.copy(
            fileName = fileName,
            source = ImportSource.detect(fileName, text),
            report = null,
            error = null,
        )
        runOpeningImport(commit = false)
    }

    /** Manual entry: one line per product (`SKU-003,40`), with the header supplied if they omitted it. */
    fun analyseOpeningTyped() {
        val current = _openingImport.value ?: return
        val typed = current.typedText.trim()
        if (typed.isEmpty()) {
            _openingImport.value = current.copy(error = "Enter at least one line, for example SKU-003,40")
            return
        }
        val firstCell = typed.lineSequence().firstOrNull()?.split(',')?.firstOrNull()?.trim().orEmpty()
        val csv = if (firstCell.equals("sku", ignoreCase = true)) typed else "sku,quantity,unit_cost\n$typed"
        _openingImport.value = current.copy(
            fileName = "Typed lines",
            source = ImportSource.Csv(csv),
            report = null,
            error = null,
        )
        runOpeningImport(commit = false)
    }

    fun commitOpeningImport() {
        runOpeningImport(commit = true)
    }

    private fun runOpeningImport(commit: Boolean) {
        val current = _openingImport.value ?: return
        val source = current.source ?: return
        viewModelScope.launch {
            _openingImport.value = current.copy(analysing = !commit, committing = commit, error = null)
            val session = sessionStore.current()
            val branchId = session.branchId
            val token = session.accessToken
            if (!session.isAuthenticated || branchId == null || token == null) {
                _openingImport.value = current.copy(
                    analysing = false,
                    committing = false,
                    error = "Sign in (Setup) and enrol this device against a branch before importing opening stock",
                )
                return@launch
            }
            runCatching { api.importOpeningStock(session.apiBaseUrl, token, branchId, current.requestId, source, commit) }
                .onSuccess { report ->
                    if (commit && report.isValid) {
                        // The on-hand projection is the visible consequence of this import, so pull
                        // it now rather than leaving the operator looking at the pre-import numbers.
                        runCatching { api.inventoryBalances(session.apiBaseUrl, token) }
                            .onSuccess { inventoryRepository.cacheBalances(it) }
                        _openingImport.value = null
                        _message.value = if (report.alreadyApplied) {
                            "Opening stock was already imported — nothing was applied twice"
                        } else {
                            "Opening stock imported: ${report.validCount} line(s), " +
                                "${units(report.totalQuantity)} unit(s), ${Pricing.formatMinor(report.totalValueMinor)} KES"
                        }
                    } else {
                        _openingImport.value = current.copy(report = report, analysing = false, committing = false)
                    }
                }
                .onFailure { failure ->
                    _openingImport.value = current.copy(analysing = false, committing = false, error = describeOpening(failure))
                }
        }
    }

    /** Server rejections carry a machine code; translate the ones an operator can act on. */
    private fun describeOpening(failure: Throwable): String {
        val api = failure as? ApiException
        val detail = api?.message ?: failure.message ?: "unknown error"
        return when (api?.code) {
            "FORBIDDEN" -> "Your role cannot import opening stock"
            "UNKNOWN_BRANCH" -> "This device is enrolled against a branch the server does not know — check Setup"
            null -> "Could not reach the server ($detail)"
            else -> "$detail (${api.code})"
        }
    }

    /** 3, not 3.0 — the same shape the Stock list uses. */
    private fun units(quantity: Double): String =
        if (quantity == Math.floor(quantity) && !quantity.isInfinite()) quantity.toLong().toString() else quantity.toString()

    // --- movement history (item 4.10) ------------------------------------------------------------

    fun openHistory(product: ProductEntity) {
        _history.value = MovementHistory(product = product, loading = true)
        loadHistory(product)
    }

    fun closeHistory() {
        _history.value = null
    }

    fun reloadHistory() {
        _history.value?.let { loadHistory(it.product) }
    }

    private fun loadHistory(product: ProductEntity) {
        viewModelScope.launch {
            val session = sessionStore.current()
            if (!session.isAuthenticated) {
                _history.value = MovementHistory(product, error = "Sign in first (Setup) to read movement history")
                return@launch
            }
            _history.value = MovementHistory(product, loading = true)
            runCatching { api.inventoryMovements(session.apiBaseUrl, session.accessToken!!, product.id) }
                .onSuccess { list -> _history.value = MovementHistory(product, movements = list) }
                .onFailure { failure ->
                    _history.value = MovementHistory(
                        product,
                        error = "Could not read history — this device shows history from the server. ${failure.message ?: ""}".trim(),
                    )
                }
        }
    }
}
