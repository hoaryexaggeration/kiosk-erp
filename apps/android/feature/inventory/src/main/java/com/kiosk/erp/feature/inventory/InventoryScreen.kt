package com.kiosk.erp.feature.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.network.ServerMovement
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun InventoryScreen(vm: InventoryViewModel) {
    val history by vm.history.collectAsState()
    val openHistory = history
    if (openHistory != null) {
        MovementHistoryScreen(history = openHistory, vm = vm)
        return
    }

    val balances by vm.balances.collectAsState()
    val products by vm.products.collectAsState()
    val message by vm.message.collectAsState()
    var delta by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Inventory", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("${balances.size} balances cached • the server owns on-hand; this device queues movements", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { vm.refresh() }) { Text("Refresh balances from server") }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = delta,
            onValueChange = { delta = it },
            label = { Text("Quantity delta (e.g. -2 or 5)") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = reason,
            onValueChange = { reason = it },
            label = { Text("Reason (required)") },
            modifier = Modifier.fillMaxWidth(),
        )
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
        Text(
            "Decreases below zero need a supervisor override — queue one here and the server will reject " +
                "it without an approver.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(8.dp))

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp), modifier = Modifier.weight(1f)) {
            item { Text("Apply adjustment to", style = MaterialTheme.typography.titleMedium) }
            if (products.isEmpty()) {
                item { Text("No products cached. Pull the catalogue in the Catalogue tab first.", style = MaterialTheme.typography.bodySmall) }
            }
            items(products) { p ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name, fontWeight = FontWeight.SemiBold)
                            Text("${p.sku} • ${Pricing.formatMinor(p.priceMinor)} KES", style = MaterialTheme.typography.bodySmall)
                        }
                        TextButton(onClick = { vm.openHistory(p) }) { Text("History") }
                        Button(onClick = { vm.adjust(p, delta.toDoubleOrNull() ?: 0.0, reason) }) { Text("Apply") }
                    }
                }
            }
            if (balances.isNotEmpty()) {
                item { Text("On-hand (cached)", style = MaterialTheme.typography.titleMedium) }
                items(balances) { b ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(b.name, fontWeight = FontWeight.SemiBold)
                            Text(b.quantity.toString(), fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
    }
}

// --- movement history (item 4.10) -----------------------------------------------------------------

@Composable
private fun MovementHistoryScreen(history: MovementHistory, vm: InventoryViewModel) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = vm::closeHistory) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            Column(Modifier.weight(1f)) {
                Text(history.product.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    "${history.product.sku} • every movement the server has recorded, newest first",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        Spacer(Modifier.height(8.dp))

        when {
            history.loading -> Text("Loading history…", style = MaterialTheme.typography.bodyMedium)
            history.error != null -> {
                Text(history.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = vm::reloadHistory) { Text("Try again") }
            }
            history.movements.isEmpty() -> Text(
                "No movements recorded for this product yet.",
                style = MaterialTheme.typography.bodyMedium,
            )
            else -> {
                val total = history.movements.sumOf { it.quantityDelta }
                Text(
                    "${history.movements.size} movements • net ${formatSignedQuantity(total)} over this window",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
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
                Text(sourceLabel(movement.sourceType), fontWeight = FontWeight.SemiBold)
                Text(
                    formatSignedQuantity(movement.quantityDelta),
                    fontFamily = FontFamily.Monospace,
                    color = if (movement.quantityDelta < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
            }
            Text(formatWhen(movement.occurredAt), style = MaterialTheme.typography.bodySmall)
            movement.reason?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            // Only issues carry COGS; showing it makes a stock loss visible in shillings, not just units.
            movement.cogsMinor?.let { cogs ->
                if (cogs > 0) {
                    Text(
                        "costed at ${Pricing.formatMinor(cogs)} KES",
                        style = MaterialTheme.typography.bodySmall,
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

/** Display only: quantities are plain numbers, so trim a trailing `.0` instead of showing 5.0. */
private fun formatSignedQuantity(quantity: Double): String {
    val rounded = Math.round(quantity * 1000.0) / 1000.0
    val text = if (rounded == Math.floor(rounded) && !rounded.isInfinite()) {
        rounded.toLong().toString()
    } else {
        rounded.toString()
    }
    return if (rounded > 0) "+$text" else text
}

/** Server timestamps are ISO-8601; fall back to the raw string rather than dropping the row. */
private fun formatWhen(iso: String): String {
    if (iso.isBlank()) return "—"
    return runCatching {
        OffsetDateTime.parse(iso)
            .atZoneSameInstant(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("dd MMM yyyy HH:mm"))
    }.getOrDefault(iso)
}
