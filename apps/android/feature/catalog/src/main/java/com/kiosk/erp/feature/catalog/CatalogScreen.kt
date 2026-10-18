package com.kiosk.erp.feature.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Pricing

@Composable
fun CatalogScreen(vm: CatalogViewModel) {
    val products by vm.products.collectAsState()
    val message by vm.message.collectAsState()
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Catalogue", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("${products.size} products cached on this device", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(8.dp))
        Button(onClick = { vm.refreshFromServer() }) { Text("Refresh from server") }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(products) { p ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("${p.name}", fontWeight = FontWeight.SemiBold)
                        Text("${p.sku} • ${Pricing.formatMinor(p.priceMinor)} KES", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
