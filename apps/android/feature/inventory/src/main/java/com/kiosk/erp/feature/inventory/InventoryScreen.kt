package com.kiosk.erp.feature.inventory

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.automirrored.filled.FactCheck
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.PostAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.common.UiTime
import com.kiosk.erp.core.database.ProductConversionEntity
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

    val transfersOpen by vm.transfersOpen.collectAsState()
    if (transfersOpen) {
        TransfersScreen(vm = vm, onBack = vm::closeTransfers)
        return
    }

    val stocktakeOpen by vm.stocktakeOpen.collectAsState()
    if (stocktakeOpen) {
        StocktakeScreen(vm = vm, onBack = vm::closeStocktake)
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
    val inTransit by vm.inTransitRows.collectAsState()

    var query by rememberSaveable { mutableStateOf("") }
    var adjusting by remember { mutableStateOf<ProductEntity?>(null) }

    val quantityByProduct = remember(balances) { balances.associate { it.productId to it.quantity } }
    val tracked = remember(products) { products.filter { it.isStockTracked } }
    val shown = remember(tracked, query) {
        val needle = query.trim()
        if (needle.isEmpty()) tracked
        else tracked.filter { it.name.contains(needle, ignoreCase = true) || it.sku.contains(needle, ignoreCase = true) }
    }
    val inTransitShown = remember(inTransit, query) {
        val needle = query.trim()
        if (needle.isEmpty()) inTransit
        else inTransit.filter { it.name.contains(needle, ignoreCase = true) || it.sku.contains(needle, ignoreCase = true) }
    }
    // Item 4.9: a breach is `balance <= threshold`, computed right here from the SAME cached
    // balances the rows below read, so the shelf speaks while the phone is offline. A `null`
    // quantity is "unknown", never zero, and a product nobody set a threshold on is never a breach.
    val breached = remember(shown, quantityByProduct) {
        shown.mapNotNull { product ->
            val threshold = product.reorderPoint ?: return@mapNotNull null
            val quantity = quantityByProduct[product.id] ?: return@mapNotNull null
            if (quantity <= threshold) LowStockItem(product, quantity, threshold) else null
        }
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
        NavRow(
            title = "Cross-branch transfers",
            subtitle = "Send stock to another branch and count what arrives — one document, two steps, queued offline",
            icon = Icons.Filled.SwapHoriz,
            onClick = vm::openTransfers,
        )

        Spacer(Modifier.height(StackGap))
        NavRow(
            title = "Stocktake",
            subtitle = "Count the shelf and queue what differs — every difference becomes a movement with your name on it",
            icon = Icons.AutoMirrored.Filled.FactCheck,
            onClick = vm::openStocktake,
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
                // The one sentence an owner needs on walking in: how many lines need buying, and
                // which. The rows below carry the per-product state (item 4.9).
                if (breached.isNotEmpty()) {
                    item(key = "low-stock-banner") {
                        Banner(
                            message = buildString {
                                append("${breached.size} product${if (breached.size == 1) "" else "s"} at or below the reorder point")
                                breached.take(3).forEach {
                                    append(" • ${it.product.name} ${Units.formatQuantity(it.quantity)} ${it.product.unit} (point ${Units.formatQuantity(it.threshold)})")
                                }
                                if (breached.size > 3) append(" • …")
                            },
                            tone = Tone.Warning,
                        )
                    }
                }
                items(shown, key = { it.id }) { product ->
                    StockRow(
                        product = product,
                        quantity = quantityByProduct[product.id],
                        onHistory = { vm.openHistory(product) },
                        onAdjust = { adjusting = product },
                    )
                }
                // Under the stock rows, what stock is NOT on this shelf but still belongs to the
                // shop: sent on a document this branch is waiting to have counted (item 4.7).
                if (inTransitShown.isNotEmpty()) {
                    item(key = "in-transit-header") {
                        Column {
                            SectionTitle(
                                "In transit from this branch",
                                caption = "Left this branch's stock on a transfer and not yet counted at the destination — counted by the document, not by either shelf",
                            )
                            Spacer(Modifier.height(StackGap))
                        }
                    }
                    items(inTransitShown, key = { "transit-${it.productId}" }) { row ->
                        InTransitCard(row = row)
                    }
                }
            }
        }
    }

    adjusting?.let { product ->
        // The pack sizes are read from Room on every open, so the dialog offers exactly what this
        // product can currently be written in — online or not (item 4.6).
        LaunchedEffect(product.id) { vm.loadPacks(product) }
        AdjustDialog(
            product = product,
            currentQuantity = quantityByProduct[product.id],
            packs = vm.packLookup.collectAsState().value,
            onDismiss = { adjusting = null },
            onApply = { entered, unit, base, reason ->
                vm.adjust(product, entered, unit, base, reason)
                adjusting = null
            },
        )
    }
}

/** One breached shelf (item 4.9): the product, what this branch holds, and where the line is. */
private data class LowStockItem(val product: ProductEntity, val quantity: Double, val threshold: Double)

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
                // Item 4.9. `quantity == null` is "not cached", not zero, so it never claims a
                // breach; out of stock is its own state because it is its own emergency.
                val threshold = product.reorderPoint
                if (threshold != null && quantity != null && quantity <= threshold) {
                    Spacer(Modifier.height(4.dp))
                    if (quantity <= 0.0) {
                        Pill("OUT OF STOCK", tone = Tone.Error)
                    } else {
                        Pill("LOW (≤ ${Units.formatQuantity(threshold)} ${product.unit})", tone = Tone.Warning)
                    }
                }
            }
            Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(horizontal = 8.dp)) {
                Text(
                    quantity?.let { "${Units.formatQuantity(it)} ${product.unit}" } ?: "—",
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
 * Stock this branch has sent but the destination has not counted yet (item 4.7). It is not on this
 * shelf — the balance already dropped when the dispatch queued — and it is not at the destination
 * either. It belongs to the document, so the card names the document(s) carrying it: `TRF-0001`,
 * or "queued on this device" while no server number exists yet.
 */
@Composable
private fun InTransitCard(row: InTransitRow) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    row.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${row.references.map { it.ifBlank { "queued on this device" } }.joinToString()} • ${row.sku}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(horizontal = 8.dp)) {
                Text(
                    "${Units.formatQuantity(row.quantity)} ${row.unit}",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text("in transit", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * Adjusting is a two-field decision with the arithmetic shown: the quantity as it was counted at
 * the shelf, the unit it was counted in, and the base quantity that will result. The reason is not
 * optional — an unexplained movement is not a fact worth posting (item 4.6).
 *
 * The conversion here is the device's PREVIEW, computed with the same reference implementation the
 * server posts with; the queued command carries what was TYPED and the server derives the base
 * quantity itself, so a screen and a ledger can never disagree about the sum.
 */
@Composable
private fun AdjustDialog(
    product: ProductEntity,
    currentQuantity: Double?,
    packs: List<ProductConversionEntity>,
    onDismiss: () -> Unit,
    onApply: (entered: Double, unit: String?, base: Double, reason: String) -> Unit,
) {
    var deltaText by remember(product.id) { mutableStateOf("") }
    var reason by remember(product.id) { mutableStateOf("") }
    var unit by remember(product.id) { mutableStateOf(product.unit) }

    val delta = deltaText.trim().toDoubleOrNull()
    val kind = product.unitKind
    val isBase = unit.equals(product.unit, ignoreCase = true)
    val packFactor = packs.firstOrNull { it.unit.equals(unit, ignoreCase = true) }?.factor

    // One rule, applied by the same code on both sides. A unit with no known kind has NO rule: the
    // dialog refuses to convert rather than inventing `count` for a weighed product that nobody has
    // typed into the unit list yet — the server will not convert without one either (item 4.6).
    val converted: Units.ConvertResult? = when {
        delta == null -> null
        isBase -> kind?.let { Units.convertQuantity(delta, 1.0, 1.0, it) } ?: Units.ConvertResult.Ok(Units.roundQuantity(delta))
        packFactor == null -> Units.ConvertResult.Failed("UNKNOWN_CONVERSION")
        kind == null -> Units.ConvertResult.Failed("UNKNOWN_UNIT_KIND")
        else -> Units.convertQuantity(delta, packFactor, 1.0, kind)
    }
    val baseDelta = (converted as? Units.ConvertResult.Ok)?.quantity
    val failure = (converted as? Units.ConvertResult.Failed)?.code
    val result = if (baseDelta != null && currentQuantity != null) currentQuantity + baseDelta else null
    val wouldGoNegative = result != null && result < 0
    val canApply = baseDelta != null && baseDelta != 0.0 && reason.isNotBlank()
    val options = remember(product.id, packs) { (listOf(product.unit) + packs.map { it.unit }).distinctBy { it.lowercase() } }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Adjust ${product.name}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                DetailRow("SKU", product.sku, monospace = true)
                DetailRow("On hand (cached)", currentQuantity?.let { "${Units.formatQuantity(it)} ${product.unit}" } ?: "not cached yet")

                if (options.size > 1) {
                    Spacer(Modifier.height(StackGap))
                    Text("Adjust in", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    options.forEach { option ->
                        val selected = option.equals(unit, ignoreCase = true)
                        val pack = packs.firstOrNull { it.unit.equals(option, ignoreCase = true) }
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().clickable { unit = option },
                        ) {
                            RadioButton(selected = selected, onClick = { unit = option })
                            Text(
                                if (pack == null) "$option — stock is held in this"
                                else "1 $option = ${Units.formatQuantity(pack.factor)} ${product.unit}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(StackGap))
                OutlinedTextField(
                    deltaText,
                    { deltaText = it },
                    label = { Text("Quantity change ($unit)") },
                    placeholder = { Text(if (isBase) "e.g. 5 or -2" else "e.g. 2 or -1") },
                    singleLine = true,
                    isError = deltaText.isNotBlank() && delta == null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (failure != null) {
                    Spacer(Modifier.height(6.dp))
                    Hint(conversionProblem(failure, unit, product.unit), tone = Tone.Error)
                } else if (delta != null && delta != 0.0 && baseDelta != null) {
                    Spacer(Modifier.height(6.dp))
                    if (!isBase) {
                        // Both numbers are shown, labelled by unit: what was counted, and what the
                        // ledger will hold. The second is the one stock is actually tracked in.
                        Text(
                            "${Units.formatQuantity(delta)} $unit = ${Units.formatQuantity(baseDelta)} ${product.unit}",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    Text(
                        "→ ${Units.formatQuantity(result ?: 0.0)} ${product.unit} on hand after this is queued",
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
                onClick = {
                    val entered = delta
                    val base = baseDelta
                    if (entered != null && base != null) onApply(entered, if (isBase) null else unit, base, reason.trim())
                },
                enabled = canApply,
            ) { Text("Queue adjustment") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * Why a conversion could not be done, in the words an operator can act on — the stable code stays
 * in the log, the sentence goes on screen (item 4.6).
 */
internal fun conversionProblem(code: String, unit: String, baseUnit: String): String = when (code) {
    "FRACTIONAL_QUANTITY" -> "$baseUnit is counted, so this has to come out as whole $baseUnit — the server would refuse it too"
    "UNKNOWN_CONVERSION" -> "This product has no $unit pack size saved, so it can only be adjusted in $baseUnit"
    "UNKNOWN_UNIT_KIND" -> "The unit list has not reached this device yet, so this pack cannot be checked — enter the change in $baseUnit"
    "INVALID_CONVERSION_FACTOR" -> "The saved $unit pack size has no usable factor — fix it in the catalogue first"
    else -> "That quantity cannot be expressed in $baseUnit"
}

/** Quantities are plain numbers: show 3, not 3.0, and 0.5 rather than 0.500. */
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
                Hint("${history.movements.size} movements • net ${Units.formatQuantity(total)} over this window — this is the server's ledger, not a local guess.")
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
                Column(horizontalAlignment = Alignment.End) {
                    // The pack the paperwork said, above the base quantity the ledger holds (item 4.6).
                    if (movement.wasConverted) {
                        Text(
                            "${formatSignedQuantity(movement.enteredQuantity ?: 0.0)} ${movement.enteredUnit} →",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    Text(
                        formatSignedQuantity(movement.quantityDelta) +
                            movement.unit.takeIf { it.isNotBlank() }?.let { " $it" }.orEmpty(),
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = if (movement.quantityDelta < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(formatWhen(movement.occurredAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            movement.reason?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            // Who the server holds as having done it: a count — and every other adjustment §15 asks
            // to be audited — names the person, so history is a record of who did what (item 4.8).
            movement.actorName?.takeIf { it.isNotBlank() }?.let {
                Text("by $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    "stocktake" -> "Stock count"
    else -> sourceType.ifBlank { "Movement" }
}

private fun formatSignedQuantity(quantity: Double): String {
    val text = Units.formatQuantity(Math.round(quantity * 1000.0) / 1000.0)
    return if (quantity > 0) "+$text" else text
}

/** Server timestamps are ISO-8601; fall back to the raw string rather than dropping the row. */
internal fun formatWhen(iso: String): String {
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
                "Columns: sku, quantity, unit_cost (money) and unit — the pack the goods arrived in, " +
                    "e.g. crate. Leave unit_cost out to use the cost already on the product. To use a " +
                    "unit column, type a header line first: sku,quantity,unit then SKU-008,10,crate. " +
                    "The whole file is checked first, and one bad row writes nothing.",
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
        StatTile("Units", Units.formatQuantity(report.totalQuantity), modifier = Modifier.weight(1f))
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
                Column(horizontalAlignment = Alignment.End) {
                    // What the file said, above what will be recorded — both labelled, never one
                    // number standing in for the other (item 4.6). Copied into locals because these
                    // come from another module and cannot be smart-cast.
                    val enteredQuantity = row.enteredQuantity
                    val enteredUnit = row.enteredUnit
                    if (enteredQuantity != null && enteredUnit != null) {
                        Text(
                            "${Units.formatQuantity(enteredQuantity)} $enteredUnit →",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    Text(
                        "${Units.formatQuantity(row.quantity)} ${row.unit}",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    "on hand ${Units.formatQuantity(row.onHandBefore)} → ${Units.formatQuantity(row.onHandAfter)} ${row.unit}",
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
