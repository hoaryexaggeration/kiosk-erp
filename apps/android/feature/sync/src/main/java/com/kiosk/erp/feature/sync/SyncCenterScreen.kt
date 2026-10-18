package com.kiosk.erp.feature.sync

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.UiTime

@Composable
fun SyncCenterScreen(vm: SyncViewModel) {
    val pending by vm.pendingCount.collectAsState()
    val attention by vm.attention.collectAsState()
    val sync by vm.syncState.collectAsState()
    val oldest by vm.oldestPending.collectAsState()
    val message by vm.message.collectAsState()

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Sync Center", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Pending on this device: $pending")
                Text("Oldest pending: ${if (oldest == null) "—" else UiTime.timeAgo(oldest)}")
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
