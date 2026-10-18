package com.kiosk.erp.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.domain.Pricing
import com.kiosk.erp.ui.PosViewModel

@Composable
fun PosScreen(vm: PosViewModel) {
    val products by vm.products.collectAsState()
    val cart by vm.cart.collectAsState()
    val message by vm.message.collectAsState()
    var query by remember { mutableStateOf("") }

    val filtered = products.filter {
        query.isBlank() || it.name.contains(query, ignoreCase = true) || it.sku.contains(query, ignoreCase = true)
    }
    val totals = vm.totals()

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Point of Sale", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Search product or SKU") },
            modifier = Modifier.fillMaxWidth(),
        )

        LazyColumn(Modifier.weight(1f)) {
            items(filtered) { product ->
                Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Row(Modifier.padding(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(product.name, fontWeight = FontWeight.SemiBold)
                            Text("${product.sku} • ${Pricing.formatMinor(product.priceMinor)} KES", style = MaterialTheme.typography.bodySmall)
                        }
                        Button(onClick = { vm.addProduct(product) }) { Text("Add") }
                    }
                }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                Text("Cart: ${cart.size} item(s)")
                Text("Subtotal ${Pricing.formatMinor(totals.subtotalMinor)} • Tax ${Pricing.formatMinor(totals.taxTotalMinor)}")
                Text("Total ${Pricing.formatMinor(totals.totalMinor)} KES", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    Button(onClick = { vm.checkout { } }, enabled = cart.isNotEmpty()) { Text("Charge cash") }
                    OutlinedButton(onClick = { vm.addTestItem() }) { Text("+ Test item") }
                    OutlinedButton(onClick = { vm.clearCart() }, enabled = cart.isNotEmpty()) { Text("Clear") }
                }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp)) }
            }
        }
    }
}
