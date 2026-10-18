package com.kiosk.erp.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun SettingsScreen(vm: SettingsViewModel) {
    val state by vm.state.collectAsState()
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Device & Sync Setup", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Bind this device to a branch, then sync offline transactions.", style = MaterialTheme.typography.bodySmall)
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
