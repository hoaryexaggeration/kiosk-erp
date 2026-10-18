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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Pricing

@Composable
fun InventoryScreen(vm: InventoryViewModel) {
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
        Spacer(Modifier.height(8.dp))

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp), modifier = Modifier.weight(1f)) {
            item { Text("Apply adjustment to", style = MaterialTheme.typography.titleMedium) }
            if (products.isEmpty()) {
                item { Text("No products cached. Pull the catalogue in the Catalogue tab first.", style = MaterialTheme.typography.bodySmall) }
            }
            items(products) { p ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name, fontWeight = FontWeight.SemiBold)
                            Text("${p.sku} • ${Pricing.formatMinor(p.priceMinor)} KES", style = MaterialTheme.typography.bodySmall)
                        }
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
