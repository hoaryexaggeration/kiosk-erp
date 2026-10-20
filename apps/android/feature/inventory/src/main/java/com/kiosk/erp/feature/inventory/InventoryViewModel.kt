package com.kiosk.erp.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.data.repository.InventoryRepository
import com.kiosk.erp.core.data.repository.ProductRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.BranchEntity
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.database.ProductConversionEntity
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.database.StockBalanceEntity
import com.kiosk.erp.core.database.StockTransferEntity
import com.kiosk.erp.core.database.StockTransferLineEntity
import com.kiosk.erp.core.network.ApiClient
import com.kiosk.erp.core.network.ApiException
import com.kiosk.erp.core.network.ImportSource
import com.kiosk.erp.core.network.OpeningStockReport
import com.kiosk.erp.core.network.ServerMovement
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
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

/**
 * One cross-branch transfer as this device holds it (item 4.7): the document, its lines, and the
 * most recent command this device has sent about it — null when nothing about it has been queued,
 * pending while it waits for a connection, and a rejection when the server sent it back.
 */
data class TransferRow(
    val transfer: StockTransferEntity,
    val lines: List<StockTransferLineEntity>,
    val command: OutboxEntity?,
)

/**
 * A product's units physically out on documents THIS branch has sent (item 4.7). Shown under the
 * stock rows because in-transit stock is stock the shelf cannot count but the shop still owns:
 * gone from this branch's balance, not yet at the destination's.
 */
data class InTransitRow(
    val productId: String,
    val sku: String,
    val name: String,
    val unit: String,
    val quantity: Double,
    /** References of the documents carrying it; blanks mean queued on this device only. */
    val references: List<String>,
)

class InventoryViewModel(
    private val inventoryRepository: InventoryRepository,
    private val productRepository: ProductRepository,
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
            runCatching { api.inventoryBalances(session.apiBaseUrl, session.accessToken!!, session.branchId) }
                .onSuccess {
                    inventoryRepository.cacheBalances(it)
                    _message.value = "Refreshed ${it.size} balances from server"
                }
                .onFailure { _message.value = "Refresh failed: ${it.message}" }
        }
    }

    /**
     * Pack sizes for the quantity dialog — adjustment (item 4.6) or transfer line (item 4.7). Empty
     * means the product has none, and the dialog then offers its base unit only: the one unit the
     * ledger actually holds.
     */
    private val _packLookup = MutableStateFlow<List<ProductConversionEntity>>(emptyList())
    val packLookup: StateFlow<List<ProductConversionEntity>> = _packLookup.asStateFlow()

    private val _sheetPacks = MutableStateFlow<Map<String, List<ProductConversionEntity>>>(emptyMap())
    val sheetPacks: StateFlow<Map<String, List<ProductConversionEntity>>> = _sheetPacks.asStateFlow()

    /**
     * Queue a stock adjustment in the unit the operator actually used (item 4.6).
     *
     * The division of labour is deliberate: the screen converts for the PREVIEW using the same
     * reference implementation the server posts with, and the command carries what was typed
     * (`-4 crate`), so the server does the conversion itself and remembers both numbers on the
     * movement. `baseQuantity` is only the device's projection of the effect — a hint for the cached
     * on-hand until the next pull, never the authority (§6).
     */
    fun adjust(product: ProductEntity, enteredQuantity: Double, unit: String?, baseQuantity: Double, reason: String) {
        viewModelScope.launch {
            if (enteredQuantity == 0.0) {
                _message.value = "Enter a non-zero quantity change"
                return@launch
            }
            if (reason.isBlank()) {
                _message.value = "A reason is required for an adjustment"
                return@launch
            }
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            inventoryRepository.createAdjustment(
                productId = product.id,
                sku = product.sku,
                name = product.name,
                enteredQuantityDelta = enteredQuantity,
                unit = unit,
                baseQuantityDelta = baseQuantity,
                reason = reason.trim(),
                branchId = branchId,
                deviceId = deviceId,
            )
            val typed = (if (enteredQuantity > 0) "+" else "") + Units.formatQuantity(enteredQuantity) + (unit?.let { " $it" } ?: "")
            _message.value = if (unit == null) {
                "Queued $typed ${product.sku} • waiting to sync"
            } else {
                // Both numbers are true and both are useful: what was counted at the shelf, and what
                // the ledger will hold once the server has done the same sum.
                "Queued $typed ${product.sku} (${"+"}${Units.formatQuantity(baseQuantity)} ${product.unit}) • waiting to sync"
            }
        }
    }

    /**
     * The pack sizes of the product whose quantity is being written — an adjustment or a transfer
     * line (items 4.6, 4.7) — read from Room so the dialog offers them while the shop is offline.
     * Refreshed on every open rather than held, because a pack retired on the server must not be
     * offered here either.
     */
    fun loadPacks(product: ProductEntity) {
        viewModelScope.launch {
            _packLookup.value = productRepository.conversions(product.id)
        }
    }

    /**
     * The pack sizes of every product currently on a count sheet (item 4.8). The dialogs load one
     * product at a time because they only ever ask about one; a sheet counts many products at once
     * and offers the packs inline, so it needs the whole set — read from Room, offline, and kept
     * until the sheet is cleared rather than refetched per keystroke.
     */
    suspend fun loadSheetPacks(productIds: Set<String>) {
        val missing = productIds.filter { it !in _sheetPacks.value }
        if (missing.isEmpty()) return
        val loaded = missing.associateWith { productRepository.conversions(it) }
        _sheetPacks.value = _sheetPacks.value + loaded
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
                        runCatching { api.inventoryBalances(session.apiBaseUrl, token, branchId) }
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

    // --- cross-branch transfers (item 4.7, ADR 0008) ---------------------------------------------

    private val _transfersOpen = MutableStateFlow(false)
    val transfersOpen: StateFlow<Boolean> = _transfersOpen.asStateFlow()

    /** This device's own branch — the line between "sent from here" and "coming to here". */
    private val _ownBranchId = MutableStateFlow<String?>(null)
    val ownBranchId: StateFlow<String?> = _ownBranchId.asStateFlow()

    init {
        viewModelScope.launch { _ownBranchId.value = sessionStore.current().branchId }
    }

    /** Branches to send to, cached so the picker works offline (item 4.7). */
    val branches: StateFlow<List<BranchEntity>> = inventoryRepository.observeBranches()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Every transfer document this branch is party to, with this device's own command state. */
    val transferRows: StateFlow<List<TransferRow>> = combine(
        inventoryRepository.observeTransfers(),
        inventoryRepository.observeTransferLines(),
        inventoryRepository.observeTransferCommands(),
    ) { transfers, lines, commands ->
        // The LATEST command per document: a corrected resubmission after a rejection is a new
        // commandId, and the newest one is the state an operator is actually looking at.
        val latest = commands
            .groupBy { it.aggregateId }
            .mapNotNull { (id, entries) -> entries.maxByOrNull { it.createdAtEpochMs }?.let { id to it } }
            .toMap()
        val byTransfer = lines.groupBy { it.transferId }
        transfers.map { TransferRow(it, byTransfer[it.id].orEmpty(), latest[it.id]) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /**
     * What is out on the road from this branch, per product (item 4.7). A document the server
     * REFUSED never moved goods, so it does not count — a rejected dispatch with a still-warm local
     * projection would otherwise put stock in transit that never left.
     */
    val inTransitRows: StateFlow<List<InTransitRow>> = combine(transferRows, _ownBranchId) { rows, branchId ->
        if (branchId == null) return@combine emptyList<InTransitRow>()
        val entries = rows
            .filter { row ->
                row.transfer.fromBranchId == branchId &&
                    row.transfer.status == "dispatched" &&
                    row.command?.status.let { it != "rejected" && it != "conflict" }
            }
            .flatMap { row -> row.lines.map { line -> row to line } }
        entries
            .groupBy({ it.second.productId }) { it }
            .map { (productId, group) ->
                val first = group.first().second
                InTransitRow(
                    productId = productId,
                    sku = first.sku,
                    name = first.name,
                    unit = first.unit,
                    quantity = group.sumOf { it.second.dispatched },
                    references = group.map { it.first.transfer.reference }.distinct(),
                )
            }
            .sortedBy { it.name }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun openTransfers() {
        _transfersOpen.value = true
        refreshTransfers()
    }

    fun closeTransfers() {
        _transfersOpen.value = false
    }

    /**
     * Catalogue search for the transfer line picker (§5 scanner/keyboard-first): name, SKU or
     * barcode over the cached products, so a scan finds an item with the network down.
     */
    private val _lineMatches = MutableStateFlow<List<ProductEntity>>(emptyList())
    val lineMatches: StateFlow<List<ProductEntity>> = _lineMatches.asStateFlow()

    fun searchLines(query: String) {
        viewModelScope.launch {
            val needle = query.trim()
            _lineMatches.value = if (needle.isEmpty()) emptyList() else productRepository.observeMatching(needle).first()
        }
    }

    /** Resolve a typed or scanned code offline: an exact barcode first, then an exact SKU. */
    suspend fun findProduct(code: String): ProductEntity? {
        val needle = code.trim()
        if (needle.isEmpty()) return null
        return productRepository.findByBarcode(needle)
            ?: products.value.firstOrNull { it.sku.equals(needle, ignoreCase = true) }
    }

    /** Pull this branch's documents and the destination list now instead of at the next sync. */
    fun refreshTransfers() {
        viewModelScope.launch {
            val session = sessionStore.current()
            val token = session.accessToken
            val branchId = session.branchId
            if (!session.isAuthenticated || token == null || branchId == null) {
                _message.value = "Offline — this device has no session, so it is showing its cached transfers"
                return@launch
            }
            runCatching {
                inventoryRepository.cacheTransfers(api.inventoryTransfers(session.apiBaseUrl, token, branchId))
                inventoryRepository.cacheBranches(api.configBranches(session.apiBaseUrl, token))
            }.onFailure { failure ->
                // A 403 is a role question, not a network one — saying "offline" about it would send
                // the operator to look at a signal bar when the answer is who they signed in as.
                _message.value = if ((failure as? ApiException)?.statusCode == 403) {
                    "Cannot read transfers: your role does not have the inventory permission — ask the owner to sign you in with it (Settings shows who you are)"
                } else {
                    "Offline — showing this device's cached transfers (${failure.message ?: "no connection"})"
                }
            }
        }
    }

    /**
     * Queue a dispatch (item 4.7). The command carries what was typed — `2 crate` — and the server
     * converts it, consumes the FIFO layers and issues the reference; this device records the
     * intent and keeps its own on-hand projection honest until the next pull (§6).
     */
    fun dispatch(
        toBranchId: String,
        toBranchName: String,
        lines: List<InventoryRepository.TransferLineDraft>,
        note: String,
        approvalNote: String,
    ) {
        viewModelScope.launch {
            if (lines.isEmpty()) {
                _message.value = "Cannot send: add at least one line"
                return@launch
            }
            val session = sessionStore.current()
            val branchId = session.branchId
            val deviceId = session.deviceId
            if (branchId == null || deviceId == null) {
                _message.value = "Cannot send: this device is not enrolled against a branch — set it up in Settings"
                return@launch
            }
            if (toBranchId == branchId) {
                _message.value = "Cannot send: this branch cannot transfer to itself"
                return@launch
            }
            val fromName = branches.value.firstOrNull { it.id == branchId }?.name ?: "this branch"
            inventoryRepository.createTransfer(
                lines = lines,
                fromBranchId = branchId,
                fromBranchName = fromName,
                toBranchId = toBranchId,
                toBranchName = toBranchName,
                note = note.ifBlank { null },
                approvalNote = approvalNote.ifBlank { null },
                deviceId = deviceId,
            )
            _message.value = "Queued ${lines.size} line(s) to $toBranchName • waiting to sync"
        }
    }

    /**
     * Queue a receipt (item 4.7): what THIS branch counted, closing the document for both sides.
     * Every dispatched line must be in `received` — the screen prefills them with what was sent —
     * and a shortage must arrive with the supervisor note that explains it (§3.D), because the
     * server refuses a short receipt without one.
     */
    fun receive(transfer: StockTransferEntity, received: Map<String, Double>, approvalNote: String) {
        viewModelScope.launch {
            val session = sessionStore.current()
            val branchId = session.branchId
            val deviceId = session.deviceId
            if (branchId == null || deviceId == null) {
                _message.value = "Cannot receive: this device is not enrolled against a branch — set it up in Settings"
                return@launch
            }
            if (transfer.toBranchId != branchId) {
                _message.value = "Cannot receive: ${transfer.reference.ifBlank { "this document" }} was sent to another branch"
                return@launch
            }
            if (transfer.status != "dispatched") {
                _message.value = "Cannot receive: this document has already been counted"
                return@launch
            }
            if (inventoryRepository.hasQueuedReceipt(transfer.id)) {
                _message.value = "Cannot receive: a receipt for ${transfer.reference.ifBlank { "this document" }} is already waiting to sync"
                return@launch
            }
            inventoryRepository.receiveTransfer(
                transfer = transfer,
                received = received,
                approvalNote = approvalNote.ifBlank { null },
                deviceId = deviceId,
            )
            _message.value = "Queued the receipt for ${transfer.reference.ifBlank { "this document" }} • waiting to sync"
        }
    }

    // --- stocktake / cycle count (item 4.8) -----------------------------------------------------

    private val _stocktakeOpen = MutableStateFlow(false)
    val stocktakeOpen: StateFlow<Boolean> = _stocktakeOpen.asStateFlow()

    fun openStocktake() {
        _stocktakeOpen.value = true
    }

    fun closeStocktake() {
        _stocktakeOpen.value = false
    }

    /**
     * Queue a count. Every line the operator entered a number for goes up, including the ones that
     * agree with the book: agreeing is still an assertion, and the server writing nothing for it is
     * exactly what keeps the movement ledger a list of things that happened. A blank line is a shelf
     * nobody counted yet, and stays behind.
     */
    fun queueStocktake(note: String, lines: List<InventoryRepository.StocktakeLineDraft>) {
        viewModelScope.launch {
            if (lines.isEmpty()) {
                _message.value = "Cannot queue the count: enter a number for at least one line"
                return@launch
            }
            val session = sessionStore.current()
            val branchId = session.branchId
            val deviceId = session.deviceId
            if (branchId == null || deviceId == null) {
                _message.value = "Cannot count: this device is not enrolled against a branch — set it up in Settings"
                return@launch
            }
            val result = inventoryRepository.createStocktake(
                note = note,
                lines = lines,
                branchId = branchId,
                deviceId = deviceId,
            )
            _stocktakeOpen.value = false
            val summary = buildString {
                append("${result.varianceLines} line(s) differ from the book")
                if (result.matchedLines > 0) append(", ${result.matchedLines} agree with it")
                append(" • waiting to sync")
            }
            _message.value = "Count queued — $summary"
        }
    }
}
