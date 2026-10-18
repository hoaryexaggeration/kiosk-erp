package com.kiosk.erp.feature.dashboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import com.kiosk.erp.core.common.UiTime

@Composable
fun DashboardScreen(vm: DashboardViewModel) {
    val gross by vm.grossMinor.collectAsState()
    val pending by vm.pendingCount.collectAsState()
    val attention by vm.attentionCount.collectAsState()
    val sync by vm.syncState.collectAsState()
    val sales by vm.recentSales.collectAsState()

    LazyColumn(modifier = Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Kiosk ERP", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("Offline-first retail. Local-first reads, cloud reconciliation.", style = MaterialTheme.typography.bodySmall)
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("Local sales total (this device)", style = MaterialTheme.typography.labelMedium)
                    Text("${Pricing.formatMinor(gross)} KES", style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.height(8.dp))
                    Text("Pending sync: $pending", style = MaterialTheme.typography.bodyMedium)
                    Text("Needs attention: $attention", style = MaterialTheme.typography.bodyMedium)
                    val reachable = sync?.serverReachable == true
                    Text(
                        "Last synced: ${UiTime.timeAgo(sync?.lastPushAtEpochMs)}" + if (reachable) " (online)" else " (offline)",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    sync?.lastError?.let { Text("Last error: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
        item { Text("Recent sales", style = MaterialTheme.typography.titleMedium) }
        if (sales.isEmpty()) {
            item { Text("No sales yet. Open the POS tab to make one.", style = MaterialTheme.typography.bodySmall) }
        }
        items(sales) { sale ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("${sale.localNumber} • ${Pricing.formatMinor(sale.totalMinor)} KES", fontWeight = FontWeight.SemiBold)
                    Text("state: ${sale.state} • ${UiTime.format(sale.createdAtEpochMs)}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
