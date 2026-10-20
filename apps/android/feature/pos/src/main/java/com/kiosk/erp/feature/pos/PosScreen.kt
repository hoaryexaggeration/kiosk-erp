package com.kiosk.erp.feature.pos

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddCircleOutline
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedIconButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.data.repository.CartLine
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.EmptyState
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone

/**
 * The cashier's screen.
 *
 * Layout follows the loop: find the item → check the cart → take the money. The two halves of that
 * loop (finding, reviewing) are one tap apart rather than stacked in one endless list, so the cart
 * stays readable when a basket reaches twenty lines, and the total never scrolls out of sight.
 */
@Composable
fun PosScreen(vm: PosViewModel, onOpenCatalogue: () -> Unit = {}) {
    val products by vm.products.collectAsState()
    val cart by vm.cart.collectAsState()
    val notice by vm.notice.collectAsState()

    var query by rememberSaveable { mutableStateOf("") }
    var showCart by rememberSaveable { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }

    val sellable = remember(products) { products.filter { it.isActive } }
    val results = remember(sellable, query) {
        val needle = query.trim()
        if (needle.isEmpty()) sellable
        else sellable.filter {
            it.name.contains(needle, ignoreCase = true) ||
                it.sku.contains(needle, ignoreCase = true) ||
                it.description?.contains(needle, ignoreCase = true) == true
        }
    }
    val totals = vm.totals()

    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        ScreenHeader(
            title = "Point of Sale",
            subtitle = "Scan or search · works offline, uploads when connected",
        )
        Spacer(Modifier.height(StackGap))

        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            ToggleButton("Find items", selected = !showCart, onClick = { showCart = false }, modifier = Modifier.weight(1f))
            ToggleButton("Cart (${cart.size})", selected = showCart, onClick = { showCart = true }, modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(StackGap))

        // Scanner-first (§5): the physical input sits ahead of the keyboard, on both halves of the
        // loop, so a till that is driven by a gun never has to touch the search box at all.
        Button(
            onClick = { scanning = true },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        ) {
            Icon(Icons.Filled.QrCodeScanner, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Scan a barcode")
        }
        Spacer(Modifier.height(StackGap))

        if (!showCart) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search name or SKU") },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }) {
                            Icon(Icons.Filled.Clear, contentDescription = "Clear search")
                        }
                    }
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(StackGap))
        }

        when {
            showCart && cart.isEmpty() -> EmptyState(
                title = "The cart is empty",
                message = "Switch to \"Find items\" and scan a barcode or search for a product to start a sale.",
                icon = Icons.Filled.ShoppingCart,
                actionLabel = "Find items",
                onAction = { showCart = false },
            )

            !showCart && sellable.isEmpty() -> EmptyState(
                title = "No products on this device",
                message = "The till sells from its own copy of the catalogue. Sync once to pull it down — after that it is here even with no connection at all.",
                icon = Icons.Filled.Inventory2,
                actionLabel = "Open catalogue",
                onAction = onOpenCatalogue,
            )

            !showCart && results.isEmpty() -> EmptyState(
                title = "Nothing matches \"$query\"",
                message = "Check the spelling, or scan the barcode instead. Deactivated products do not appear here.",
                icon = Icons.Filled.Search,
                actionLabel = "Clear search",
                onAction = { query = "" },
            )

            showCart -> LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(StackGap),
                contentPadding = PaddingValues(bottom = StackGap),
            ) {
                itemsIndexed(cart, key = { index, line -> "${line.productId ?: line.sku}:$index" }) { index, line ->
                    CartRow(
                        line = line,
                        onStep = { step -> vm.changeQuantity(index, step) },
                        onRemove = { vm.removeLine(index) },
                    )
                }
                item {
                    Hint("Quantity steps are whole units for now; weight and unit conversion arrive with the till's quantity entry.")
                }
            }

            else -> LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(StackGap),
                contentPadding = PaddingValues(bottom = StackGap),
            ) {
                itemsIndexed(results, key = { _, product -> product.id }) { _, product ->
                    ProductRow(product = product, onAdd = { vm.addProduct(product) })
                }
            }
        }

        notice?.let { current ->
            Spacer(Modifier.height(StackGap))
            Banner(
                message = current.text,
                tone = if (current.isError) Tone.Error else Tone.Success,
                onDismiss = vm::clearNotice,
            )
        }

        Spacer(Modifier.height(StackGap))
        TotalsCard(
            lineCount = cart.size,
            subtotalMinor = totals.subtotalMinor,
            taxMinor = totals.taxTotalMinor,
            totalMinor = totals.totalMinor,
            onCharge = { vm.checkout { showCart = false } },
            onClear = { confirmClear = true },
        )
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear the cart?") },
            text = { Text("${cart.size} item(s) and a total of ${Pricing.formatMinor(totals.totalMinor)} KES will be discarded. No sale is recorded.") },
            confirmButton = { TextButton(onClick = { vm.clearCart(); confirmClear = false }) { Text("Clear cart") } },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Keep") } },
        )
    }

    if (scanning) {
        BarcodeScannerOverlay(
            onCode = { code, onOutcome -> vm.onBarcode(code, onOutcome) },
            onDismiss = { scanning = false },
        )
    }
}

/** The two halves of the screen's loop, as a single obvious choice. */
@Composable
private fun ToggleButton(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    if (selected) {
        Button(onClick = onClick, modifier = modifier.heightIn(min = 44.dp)) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = 44.dp)) { Text(label) }
    }
}

@Composable
private fun ProductRow(product: ProductEntity, onAdd: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onAdd).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    product.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${product.sku} • per ${product.unit}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(start = 8.dp)) {
                Text(
                    "${Pricing.formatMinor(product.priceMinor)} KES",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text("tap to add", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(
                Icons.Filled.AddCircleOutline,
                contentDescription = "Add ${product.name} to the cart",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun CartRow(line: CartLine, onStep: (Int) -> Unit, onRemove: () -> Unit) {
    // Computed with the same pricing function the sale itself uses, so the line total shown here is
    // exactly the amount that will be recorded — never a hand-rolled sum that could disagree.
    val lineTotal = Pricing.computeLine(
        Pricing.LineInput(line.unitPriceMinor, line.quantity, line.discountBp, line.taxRateBp, line.taxInclusive),
    ).lineTotalMinor
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        line.name,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "${line.sku} • ${Pricing.formatMinor(line.unitPriceMinor)} KES each",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    "${Pricing.formatMinor(lineTotal)} KES",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedIconButton(onClick = { onStep(-1) }, modifier = Modifier.heightIn(min = 44.dp)) {
                    Icon(Icons.Filled.Remove, contentDescription = "One fewer ${line.name}")
                }
                Text(
                    Units.formatQuantity(line.quantity),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 14.dp),
                )
                OutlinedIconButton(onClick = { onStep(1) }, modifier = Modifier.heightIn(min = 44.dp)) {
                    Icon(Icons.Filled.Add, contentDescription = "One more ${line.name}")
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onRemove, modifier = Modifier.heightIn(min = 44.dp)) {
                    Icon(
                        Icons.Filled.Delete,
                        contentDescription = "Remove ${line.name} from the cart",
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

/** Quantities are plain numbers: show 3, not 3.0, and 0.5 rather than 0.500. */
@Composable
private fun TotalsCard(
    lineCount: Int,
    subtotalMinor: Long,
    taxMinor: Long,
    totalMinor: Long,
    onCharge: () -> Unit,
    onClear: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    AmountLine("Subtotal", subtotalMinor)
                    AmountLine("Tax", taxMinor)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        "${Pricing.formatMinor(totalMinor)} KES",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        if (lineCount == 0) "cart is empty" else "$lineCount line(s)",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
                Button(
                    onClick = onCharge,
                    enabled = lineCount > 0,
                    modifier = Modifier.weight(1.6f).heightIn(min = 52.dp),
                ) { Text("Record cash sale") }
                OutlinedButton(
                    onClick = onClear,
                    enabled = lineCount > 0,
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                ) { Text("Clear") }
            }
        }
    }
}

@Composable
private fun AmountLine(label: String, minor: Long) {
    Row(Modifier.padding(vertical = 2.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(72.dp),
        )
        Text(Pricing.formatMinor(minor), style = MaterialTheme.typography.bodyMedium)
    }
}
