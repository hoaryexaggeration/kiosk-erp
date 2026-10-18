package com.kiosk.erp.ui.screens

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
import androidx.compose.material3.HorizontalDivider
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
import com.kiosk.erp.domain.Pricing
import com.kiosk.erp.ui.CatalogViewModel
import com.kiosk.erp.ui.DashboardViewModel
import com.kiosk.erp.ui.InventoryViewModel
import com.kiosk.erp.ui.LicenseViewModel
import com.kiosk.erp.ui.SettingsViewModel
import com.kiosk.erp.ui.SyncViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private fun timeAgo(epochMs: Long?): String {
    if (epochMs == null) return "never"
    val diff = (System.currentTimeMillis() - epochMs) / 1000
    return when {
        diff < 60 -> "${diff}s ago"
        diff < 3600 -> "${diff / 60}m ago"
        else -> "${diff / 3600}h ago"
    }
}

private fun ts(epochMs: Long?): String {
    if (epochMs == null) return "—"
    val fmt = SimpleDateFormat("dd MMM HH:mm", Locale.US)
    return fmt.format(Date(epochMs))
}

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
                        "Last synced: ${timeAgo(sync?.lastPushAtEpochMs)}" + if (reachable) " (online)" else " (offline)",
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
                    Text("state: ${sale.state} • ${ts(sale.createdAtEpochMs)}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

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

@Composable
fun SyncCenterScreen(vm: SyncViewModel) {    val pending by vm.pendingCount.collectAsState()
    val attention by vm.attention.collectAsState()
    val sync by vm.syncState.collectAsState()
    val oldest by vm.oldestPending.collectAsState()
    val message by vm.message.collectAsState()

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Sync Center", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Pending on this device: $pending")
                Text("Oldest pending: ${if (oldest == null) "—" else timeAgo(oldest)}")
                Text("Needs attention: ${attention.size}")
                Text("Cursor: ${sync?.cursor ?: 0}")
                Text("Server reachable: ${sync?.serverReachable == true}")
                sync?.lastError?.let { Text("Last error: $it", color = MaterialTheme.colorScheme.error) }
            }
        }
        Button(onClick = { vm.syncNow() }, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
        OutlinedButton(onClick = { vm.createTestCommand() }, modifier = Modifier.fillMaxWidth()) { Text("Create offline test command") }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        if (attention.isNotEmpty()) {
            Text("Needs attention (never dismissed silently)", style = MaterialTheme.typography.titleMedium)
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(attention) { entry ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text("${entry.aggregateType} ${entry.aggregateId.take(8)}", fontWeight = FontWeight.SemiBold)
                            Text("status: ${entry.status}${entry.conflictCode?.let { " • $it" } ?: ""}", style = MaterialTheme.typography.bodySmall)
                            entry.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                            Text("attempts: ${entry.attempts}", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun LicenseScreen(vm: LicenseViewModel) {
    val result by vm.result.collectAsState()
    val error by vm.error.collectAsState()
    var pem by remember { mutableStateOf("") }
    var jws by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("License & Plan", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Import a signed offline renewal package. The app verifies it with the issuer's public key and never trusts an unsigned file.", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(
            value = pem,
            onValueChange = { pem = it },
            label = { Text("Issuer public key (PEM)") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = jws,
            onValueChange = { jws = it },
            label = { Text("Signed package (JWS)") },
            minLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { vm.verify(jws, pem) }, modifier = Modifier.fillMaxWidth()) { Text("Verify & import") }
        OutlinedButton(onClick = { vm.reset() }) { Text("Clear") }
        error?.let { Text("Rejected: $it", color = MaterialTheme.colorScheme.error) }
        result?.let { p ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("Package verified", fontWeight = FontWeight.SemiBold)
                    HorizontalDivider(Modifier.padding(vertical = 6.dp))
                    Text("serial: ${p.packageSerial}")
                    Text("plan: ${p.planId} (${p.editionId})")
                    Text("revision: ${p.revision}")
                    Text("perpetual core: ${p.perpetualCore}")
                    Text("maintenance expires: ${p.maintenanceExpiresAt ?: "—"}")
                    Text("connected services: ${p.connectedServicesExpiresAt ?: "not included"}")
                    Text("devices: ${p.deviceQuota} • branches: ${p.branchQuota}")
                    Text("entitlements: ${p.entitlementIds.joinToString()}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    Text("kid: ${p.kid}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
fun SettingsScreen(vm: SettingsViewModel) {
    val state by vm.state.collectAsState()
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Device & Sync Setup", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Phase 3: bind this device to a branch, then sync offline transactions.", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(
            state.apiBaseUrl,
            { v -> vm.update { it.copy(apiBaseUrl = v) } },
            label = { Text("API base URL (reachable from device)") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(state.email, { v -> vm.update { it.copy(email = v) } }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(state.password, { v -> vm.update { it.copy(password = v) } }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(state.branchId, { v -> vm.update { it.copy(branchId = v) } }, label = { Text("Branch id (UUID)") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(state.deviceId, { v -> vm.update { it.copy(deviceId = v) } }, label = { Text("Device id (UUID, generated)") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { vm.setup() }, modifier = Modifier.fillMaxWidth()) { Text(if (state.configured) "Re-run setup" else "Enroll this device") }
        state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Text("Device clock & permissions are not trusted for financial ordering; the server assigns canonical order.", style = MaterialTheme.typography.bodySmall)
    }
}
