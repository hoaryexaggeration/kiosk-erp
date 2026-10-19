package com.kiosk.erp.feature.license

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Verified
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.DetailRow
import com.kiosk.erp.core.designsystem.FieldLabel
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone

/**
 * Licence import. Two boxes of cryptographic text are inherently intimidating, so the screen says
 * what each one is in a caption, refuses to run an incomplete pair, and reports the outcome as a
 * single word (verified / rejected) before it lists the detail.
 */
@Composable
fun LicenseScreen(vm: LicenseViewModel) {
    val result by vm.result.collectAsState()
    val error by vm.error.collectAsState()
    var pem by rememberSaveable { mutableStateOf("") }
    var jws by rememberSaveable { mutableStateOf("") }
    val readyToVerify = pem.isNotBlank() && jws.isNotBlank()

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(StackGap),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            ScreenHeader(
                title = "Licence & plan",
                subtitle = "Import a signed renewal package issued by the vendor",
            )
        }

        item {
            Hint(
                "The app verifies the package with the issuer's public key and never trusts an unsigned " +
                    "file — an edited text file is rejected, not accepted.",
            )
        }

        item { SectionTitle("Issuer public key", caption = "PEM, as supplied with your licence.") }
        item {
            OutlinedTextField(
                value = pem,
                onValueChange = { pem = it },
                label = { Text("Public key (PEM)") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item { SectionTitle("Signed package", caption = "The JWS your licence was issued as.") }
        item {
            OutlinedTextField(
                value = jws,
                onValueChange = { jws = it },
                label = { Text("Signed package (JWS)") },
                minLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item {
            Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
                Button(
                    onClick = { vm.verify(jws, pem) },
                    enabled = readyToVerify,
                    modifier = Modifier.weight(1.6f).heightIn(min = 50.dp),
                ) { Text("Verify & import") }
                OutlinedButton(
                    onClick = { vm.reset(); pem = ""; jws = "" },
                    modifier = Modifier.weight(1f).heightIn(min = 50.dp),
                ) { Text("Clear") }
            }
        }
        if (!readyToVerify) {
            item { Hint("Paste both the public key and the signed package to verify.", tone = Tone.Neutral) }
        }

        error?.let { message ->
            item {
                Banner(
                    message = "Rejected: $message",
                    tone = Tone.Error,
                    actionLabel = "Clear",
                    onAction = { vm.reset(); pem = ""; jws = "" },
                )
            }
        }

        result?.let { payload ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Pill("Package verified", Tone.Success, icon = Icons.Filled.Verified)
                        Spacer(Modifier.height(10.dp))
                        DetailRow("Serial", payload.packageSerial, monospace = true)
                        DetailRow("Plan", "${payload.planId} (${payload.editionId})")
                        DetailRow("Revision", "${payload.revision}")
                        HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        DetailRow("Perpetual core", if (payload.perpetualCore) "included" else "not included")
                        DetailRow("Maintenance", payload.maintenanceExpiresAt ?: "—")
                        DetailRow(
                            "Connected services",
                            payload.connectedServicesExpiresAt ?: "not included",
                        )
                        DetailRow("Device quota", "${payload.deviceQuota}")
                        DetailRow("Branch quota", "${payload.branchQuota}")
                        HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        FieldLabel("Entitlements")
                        Text(
                            payload.entitlementIds.joinToString(),
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                        )
                        Spacer(Modifier.height(6.dp))
                        FieldLabel("Key id")
                        Text(payload.kid, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
