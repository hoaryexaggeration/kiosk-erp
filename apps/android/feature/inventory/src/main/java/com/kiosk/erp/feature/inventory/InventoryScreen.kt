package com.kiosk.erp.feature.inventory

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.PostAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.common.UiTime
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.DetailRow
import com.kiosk.erp.core.designsystem.EmptyState
import com.kiosk.erp.core.designsystem.FieldLabel
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.LoadingState
import com.kiosk.erp.core.designsystem.NavRow
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.StatTile
import com.kiosk.erp.core.designsystem.Tone
import com.kiosk.erp.core.network.OpeningStockPreviewRow
import com.kiosk.erp.core.network.OpeningStockReport
import com.kiosk.erp.core.network.ServerMovement
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Stock on this device.
 *
 * The screen leads with on-hand per product because that is the question at the shelf; adjusting is
 * a deliberate second step behind a dialog that shows the resulting quantity before it is queued, so
 * nobody changes stock by accidentally tapping a form that was already filled in.
 */
@Composable
fun InventoryScreen(vm: InventoryViewModel, onOpenCatalogue: () -> Unit = {}) {
    // Registered before any early return so the picker exists whichever screen is on top.
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            scope.launch {
                val text = withContext(Dispatchers.IO) {
                    runCatching { context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } }.getOrNull()
                }
                if (text == null) vm.openingReadFailed() else vm.analyseOpeningFile(displayName(context, uri), text)
            }
        }
    }

    val history = vm.history.collectAsState().value
    if (history != null) {
        MovementHistoryScreen(history = history, vm = vm)
        return
    }

    val opening = vm.openingImport.collectAsState().value
    if (opening != null) {
        OpeningStockScreen(state = opening, vm = vm, onPickFile = { filePicker.launch(OPENING_MIME_TYPES) })
        return
    }

    val balances by vm.balances.collectAsState()
    val products by vm.products.collectAsState()
    val message by vm.message.collectAsState()

    var query by rememberSaveable { mutableStateOf("") }
    var adjusting by remember { mutableStateOf<ProductEntity?>(null) }

    val quantityByProduct = remember(balances) { balances.associate { it.productId to it.quantity } }
    val tracked = remember(products) { products.filter { it.isStockTracked } }
    val shown = remember(tracked, query) {
        val needle = query.trim()
        if (needle.isEmpty()) tracked
        else tracked.filter { it.name.contains(needle, ignoreCase = true) || it.sku.contains(needle, ignoreCase = true) }
    }
    val cachedAt = remember(balances) { balances.maxOfOrNull { it.updatedAtEpochMs } }

    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        ScreenHeader(
            title = "Stock",
            subtitle = "On-hand per product · adjustments queue offline and post on the next sync",
            actions = {
                IconButton(onClick = { vm.refresh() }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh balances from the server")
                }
            },
        )
        Spacer(Modifier.height(StackGap))

        Banner(
            message = "The server owns stock. This device shows its cached projection" +
                (cachedAt?.let { ", last refreshed ${UiTime.timeAgo(it)}" } ?: "") + " and queues every change it is asked to make.",
            tone = Tone.Info,
        )

        message?.let {
            Spacer(Modifier.height(StackGap))
            Banner(
                message = it,
                tone = if (it.startsWith("Refresh failed") || it.startsWith("Enter") || it.startsWith("A reason")) Tone.Error else Tone.Success,
                onDismiss = vm::clearMessage,
            )
        }

        Spacer(Modifier.height(StackGap))
        NavRow(
            title = "Opening stock",
            subtitle = "Import opening balances for this branch — checked in full first, posted as movements, all or nothing",
            icon = Icons.Filled.PostAdd,
            onClick = vm::openOpeningImport,
        )

        Spacer(Modifier.height(StackGap))
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Search name or SKU") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Clear, contentDescription = "Clear search") }
                }
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(StackGap))

        when {
            products.isEmpty() -> EmptyState(
                title = "No products on this device",
                message = "Stock is shown for the products cached from the catalogue. Refresh the catalogue first, then come back here.",
                icon = Icons.Filled.Inventory2,
                actionLabel = "Open catalogue",
                onAction = onOpenCatalogue,
            )

            shown.isEmpty() -> EmptyState(
                title = "Nothing matches \"$query\"",
                message = "Only stock-tracked products appear on this screen.",
                icon = Icons.Filled.Search,
                actionLabel = "Clear search",
                onAction = { query = "" },
            )

            else -> LazyColumn(
                verticalArrangement = Arrangement.spacedBy(StackGap),
                contentPadding = PaddingValues(bottom = 24.dp),
                modifier = Modifier.weight(1f),
            ) {
                items(shown, key = { it.id }) { product ->
                    StockRow(
                        product = product,
                        quantity = quantityByProduct[product.id],
                        onHistory = { vm.openHistory(product) },
                        onAdjust = { adjusting = product },
                    )
                }
            }
        }
    }

    adjusting?.let { product ->
        AdjustDialog(
            product = product,
            currentQuantity = quantityByProduct[product.id],
            onDismiss = { adjusting = null },
            onApply = { delta, reason ->
                vm.adjust(product, delta, reason)
                adjusting = null
            },
        )
    }
}

@Composable
private fun StockRow(product: ProductEntity, quantity: Double?, onHistory: () -> Unit, onAdjust: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    product.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    product.sku,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(horizontal = 8.dp)) {
                Text(
                    quantity?.let { formatQuantity(it) } ?: "—",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    color = if (quantity == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                Text("on hand", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onHistory) {
                Icon(Icons.Filled.History, contentDescription = "Movement history for ${product.name}")
            }
            OutlinedButton(onClick = onAdjust, modifier = Modifier.heightIn(min = 40.dp)) { Text("Adjust") }
        }
    }
}

/**
 * Adjusting is a two-field decision with the arithmetic shown: current, delta, and the quantity that
 * will result. The reason is not optional — an unexplained movement is not a fact worth posting.
 */
@Composable
private fun AdjustDialog(
    product: ProductEntity,
    currentQuantity: Double?,
    onDismiss: () -> Unit,
    onApply: (Double, String) -> Unit,
) {
    var deltaText by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    val delta = deltaText.trim().toDoubleOrNull()
    val result = if (delta != null && currentQuantity != null) currentQuantity + delta else null
    val wouldGoNegative = result != null && result < 0
    val canApply = delta != null && delta != 0.0 && reason.isNotBlank()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Adjust ${product.name}") },
        text = {
            Column {
                DetailRow("SKU", product.sku, monospace = true)
                DetailRow("On hand (cached)", currentQuantity?.let { formatQuantity(it) } ?: "not cached yet")
                Spacer(Modifier.height(StackGap))
                OutlinedTextField(
                    deltaText,
                    { deltaText = it },
                    label = { Text("Quantity change") },
                    placeholder = { Text("e.g. 5 or -2") },
                    singleLine = true,
                    isError = deltaText.isNotBlank() && delta == null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (delta != null && delta != 0.0) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "→ ${formatQuantity(result ?: 0.0)} on hand after this is queued",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(StackGap))
                OutlinedTextField(
                    reason,
                    { reason = it },
                    label = { Text("Reason (required)") },
                    placeholder = { Text("stocktake, damage, received…") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (wouldGoNegative) {
                    Spacer(Modifier.height(StackGap))
                    Banner(
                        message = "This would take the product below zero. The server refuses that unless a supervisor adds an override, so expect it to come back for review.",
                        tone = Tone.Warning,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { delta?.let { onApply(it, reason.trim()) } },
                enabled = canApply,
            ) { Text("Queue adjustment") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Quantities are plain numbers: show 3, not 3.0, and 0.5 rather than 0.500. */
private fun formatQuantity(quantity: Double): String =
    if (quantity == Math.floor(quantity) && !quantity.isInfinite()) quantity.toLong().toString() else quantity.toString()

// --- movement history (item 4.10) -----------------------------------------------------------------

@Composable
private fun MovementHistoryScreen(history: MovementHistory, vm: InventoryViewModel) {
    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        ScreenHeader(
            title = history.product.name,
            subtitle = "${history.product.sku} • every movement the server has recorded, newest first",
            onBack = vm::closeHistory,
        )
        Spacer(Modifier.height(StackGap))

        when {
            history.loading -> LoadingState("Reading movement history from the server…")
            history.error != null -> Banner(
                message = history.error.orEmpty(),
                tone = Tone.Error,
                actionLabel = "Try again",
                onAction = vm::reloadHistory,
            )
            history.movements.isEmpty() -> EmptyState(
                title = "No movements yet",
                message = "Opening stock, receipts, sales and adjustments will all appear here, with what each one cost.",
                icon = Icons.Filled.History,
            )
            else -> {
                val total = history.movements.sumOf { it.quantityDelta }
                Hint("${history.movements.size} movements • net ${formatQuantity(total)} over this window — this is the server's ledger, not a local guess.")
                Spacer(Modifier.height(StackGap))
                LazyColumn(verticalArrangement = Arrangement.spacedBy(StackGap), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(history.movements, key = { it.id }) { movement -> MovementRow(movement) }
                }
            }
        }
    }
}

@Composable
private fun MovementRow(movement: ServerMovement) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Pill(sourceLabel(movement.sourceType), if (movement.quantityDelta < 0) Tone.Error else Tone.Success)
                Text(
                    formatSignedQuantity(movement.quantityDelta),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = if (movement.quantityDelta < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(formatWhen(movement.occurredAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            movement.reason?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            // Only issues carry COGS; showing it makes a stock loss visible in shillings, not just units.
            movement.cogsMinor?.let { cogs ->
                if (cogs > 0) {
                    Text(
                        "costed at ${Pricing.formatMinor(cogs)} KES",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

private fun sourceLabel(sourceType: String): String = when (sourceType) {
    "opening_stock" -> "Opening stock"
    "stock_receipt" -> "Stock receipt"
    "stock_adjustment" -> "Adjustment"
    "sale" -> "Sale"
    "stock_transfer" -> "Transfer"
    else -> sourceType.ifBlank { "Movement" }
}

private fun formatSignedQuantity(quantity: Double): String {
    val text = formatQuantity(Math.round(quantity * 1000.0) / 1000.0)
    return if (quantity > 0) "+$text" else text
}

/** Server timestamps are ISO-8601; fall back to the raw string rather than dropping the row. */
private fun formatWhen(iso: String): String {
    if (iso.isBlank()) return "—"
    return runCatching {
        java.time.OffsetDateTime.parse(iso)
            .atZoneSameInstant(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("dd MMM yyyy HH:mm"))
    }.getOrDefault(iso)
}

// --- opening-stock import (item 4.5) -----------------------------------------------------------------

/** Most CSV files arrive as `text/csv`; JSON is accepted too, via the same column vocabulary. */
private val OPENING_MIME_TYPES = arrayOf("text/*", "application/json", "application/vnd.ms-excel")

/** One report issue per line is plenty to act on; the count after it covers the rest. */
private const val MAX_REPORT_ISSUES = 20

private fun displayName(context: Context, uri: Uri): String = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
}.getOrNull() ?: uri.lastPathSegment ?: "import"

/** `line 4, SKU-003 — the words an operator needs, in the order they need them. */
private fun issueLabel(line: Int, sku: String?, message: String): String =
    "line $line${sku?.takeIf { it.isNotBlank() }?.let { ", $it" } ?: ""} — $message"

/**
 * Opening stock: pick a file or type the lines, then read what the server says every line will do
 * before any of it is written.
 *
 * Nothing on this screen can set a quantity. The report is a list of movements that will be
 * APPENDED, each showing the balance before and after — so the operator approves an event that
 * happened on a date, not an edit to a stored number (item 4.5's exit criterion).
 */
@Composable
private fun OpeningStockScreen(
    state: OpeningImportState,
    vm: InventoryViewModel,
    onPickFile: () -> Unit,
) {
    val report = state.report
    Column(Modifier.fillMaxSize().padding(ScreenPadding).verticalScroll(rememberScrollState())) {
        ScreenHeader(
            title = "Opening stock",
            subtitle = "Opening balances are posted as movements, all or nothing — never as an edit to a quantity",
            onBack = vm::closeOpeningImport,
        )
        Spacer(Modifier.height(StackGap))

        if (state.source == null) {
            Hint(
                "Columns: sku, quantity, unit_cost. unit_cost is optional — leave it out to use the cost " +
                    "already on the product. The whole file is checked first, and one bad row writes nothing.",
            )
            Spacer(Modifier.height(StackGap))
            OutlinedButton(onClick = onPickFile, modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp)) {
                Icon(Icons.Filled.UploadFile, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Choose a CSV or JSON file")
            }
            Spacer(Modifier.height(StackGap))
            FieldLabel("Or type the lines")
            OutlinedTextField(
                value = state.typedText,
                onValueChange = vm::setOpeningTypedText,
                placeholder = { Text("SKU-003,40\nSKU-004,24,265") },
                minLines = 4,
                maxLines = 8,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(StackGap))
            OutlinedButton(
                onClick = vm::analyseOpeningTyped,
                enabled = !state.analysing,
                modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp),
            ) {
                Text(if (state.analysing) "Checking every line…" else "Preview typed lines")
            }
        }

        state.error?.let { error ->
            Spacer(Modifier.height(StackGap))
            Banner(message = error, tone = Tone.Error, onDismiss = vm::clearOpeningError)
        }

        if (state.analysing) {
            Spacer(Modifier.height(StackGap))
            LoadingState("The server is checking every line against the catalogue and current stock…")
        }

        report?.let { OpeningReport(state = state, report = it, vm = vm) }
    }
}

/** The server's answer: what is ready, what blocks it, what it is worth, and what it changes. */
@Composable
private fun OpeningReport(state: OpeningImportState, report: OpeningStockReport, vm: InventoryViewModel) {
    val ready = report.isValid

    Spacer(Modifier.height(StackGap))
    SectionTitle(
        if (state.fileName.isBlank()) "Report" else "Report for ${state.fileName}",
        caption = if (ready) "Nothing has been written yet — the import happens when you confirm it below."
        else "Nothing has been written.",
    )
    Spacer(Modifier.height(StackGap))
    Pill(
        text = when {
            !ready -> "${report.errorCount} problem(s)"
            report.warningCount > 0 -> "Ready to import — ${report.warningCount} warning(s)"
            else -> "Ready to import"
        },
        tone = if (!ready) Tone.Error else if (report.warningCount > 0) Tone.Warning else Tone.Success,
    )
    Spacer(Modifier.height(StackGap))
    Row(horizontalArrangement = Arrangement.spacedBy(StackGap), modifier = Modifier.fillMaxWidth()) {
        StatTile("Lines", report.validCount.toString(), caption = "of ${report.rowCount}", modifier = Modifier.weight(1f))
        StatTile("Units", formatQuantity(report.totalQuantity), modifier = Modifier.weight(1f))
        StatTile("Value", Pricing.formatMinor(report.totalValueMinor), caption = "KES", modifier = Modifier.weight(1f))
    }

    if (report.warnings.isNotEmpty()) {
        Spacer(Modifier.height(StackGap))
        SectionTitle("Check these first", caption = "A warning does not stop the import — you decide.")
        Spacer(Modifier.height(StackGap))
        report.warnings.take(MAX_REPORT_ISSUES).forEach { warning ->
            Banner(message = issueLabel(warning.line, warning.sku, warning.message), tone = Tone.Warning)
            Spacer(Modifier.height(6.dp))
        }
        if (report.warnings.size > MAX_REPORT_ISSUES) {
            Hint("…and ${report.warnings.size - MAX_REPORT_ISSUES} more warning(s).")
        }
    }

    if (report.errors.isNotEmpty()) {
        Spacer(Modifier.height(StackGap))
        SectionTitle("Problems", caption = "One problem row means none of the file is written.")
        Spacer(Modifier.height(StackGap))
        report.errors.take(MAX_REPORT_ISSUES).forEach { error ->
            Banner(message = issueLabel(error.line, error.sku, error.message), tone = Tone.Error)
            Spacer(Modifier.height(6.dp))
        }
        if (report.errors.size > MAX_REPORT_ISSUES) {
            Hint("…and ${report.errors.size - MAX_REPORT_ISSUES} more problem(s).")
        }
    }

    if (report.preview.isNotEmpty()) {
        Spacer(Modifier.height(StackGap))
        SectionTitle(
            "Lines to be posted",
            caption = if (report.previewTruncated) "first ${report.preview.size} of ${report.validCount}" else null,
        )
        Spacer(Modifier.height(StackGap))
        report.preview.forEach { row ->
            OpeningRow(row)
            Spacer(Modifier.height(StackGap))
        }
        if (report.previewTruncated) {
            Hint("…and ${report.validCount - report.preview.size} more lines. All of them are checked and all of them post.")
        }
    }

    Spacer(Modifier.height(StackGap))
    Button(
        onClick = vm::commitOpeningImport,
        enabled = ready && !state.committing,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    ) {
        Text(
            if (state.committing) "Importing…"
            else "Import ${report.validCount} line(s)" +
                if (report.warningCount > 0) " — ${report.warningCount} warning(s)" else "",
        )
    }
    Spacer(Modifier.height(StackGap))
    OutlinedButton(onClick = vm::closeOpeningImport, modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp)) {
        Text("Back to Stock")
    }
}

/** One planned movement: quantity in, balance before → after, and what it will be worth. */
@Composable
private fun OpeningRow(row: OpeningStockPreviewRow) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${row.sku} · ${row.name}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    formatQuantity(row.quantity),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    "on hand ${formatQuantity(row.onHandBefore)} → ${formatQuantity(row.onHandAfter)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "${Pricing.formatMinor(row.valueMinor)} KES",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "line ${row.line} · ${row.unit}" + if (row.costWasGiven) "" else " · cost taken from the product",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
