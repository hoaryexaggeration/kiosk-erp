package com.kiosk.erp.feature.license

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
