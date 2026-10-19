package com.kiosk.erp.feature.inventory

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.LoadingState
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone
import com.kiosk.erp.core.network.ServerMovement

/**
 * Stock on this device.
 *
 * The screen leads with on-hand per product because that is the question at the shelf; adjusting is
 * a deliberate second step behind a dialog that shows the resulting quantity before it is queued, so
 * nobody changes stock by accidentally tapping a form that was already filled in.
 */
@Composable
fun InventoryScreen(vm: InventoryViewModel, onOpenCatalogue: () -> Unit = {}) {
    val history = vm.history.collectAsState().value
    if (history != null) {
        MovementHistoryScreen(history = history, vm = vm)
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
