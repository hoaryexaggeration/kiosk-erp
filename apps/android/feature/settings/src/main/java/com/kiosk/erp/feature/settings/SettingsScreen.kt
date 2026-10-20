package com.kiosk.erp.feature.settings

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.DetailRow
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.LoadingState
import com.kiosk.erp.core.designsystem.NavRow
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone

/**
 * First-run setup and administration.
 *
 * The two opaque identifiers (branch, device) used to sit among the fields a person actually types.
 * They are now their own section with plain-language captions: enrolment only needs them once, they
 * normally come from support, and mixing them with email/password is how people end up pasting a
 * UUID into the wrong box.
 */
@Composable
fun SettingsScreen(
    vm: SettingsViewModel,
    onOpenCatalog: () -> Unit = {},
    onOpenLicense: () -> Unit = {},
) {
    val state by vm.state.collectAsState()

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(StackGap),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            ScreenHeader(
                title = "Setup",
                subtitle = "Bind this device to a branch — then everything it records can sync",
            )
        }

        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Pill(
                        if (state.configured) "Ready to sync" else "Not enrolled",
                        if (state.configured) Tone.Success else Tone.Warning,
                        icon = if (state.configured) Icons.Filled.CheckCircle else Icons.Filled.Warning,
                    )
                    Spacer(Modifier.height(8.dp))
                    DetailRow("Account", state.email.ifBlank { "not signed in" })
                    DetailRow("Branch", state.branchId.ifBlank { "—" })
                    DetailRow("Device", state.deviceId.ifBlank { "—" })
                }
            }
        }

        state.message?.let { text ->
            item {
                Banner(
                    message = text,
                    tone = if (text.startsWith("Setup failed") || text.startsWith("Fill in")) Tone.Error else Tone.Success,
                    onDismiss = vm::clearMessage,
                )
            }
        }

        item {
            SectionTitle("Connection", caption = "Where this device reaches the control plane.")
        }
        item {
            OutlinedTextField(
                state.apiBaseUrl,
                { v -> vm.update { it.copy(apiBaseUrl = v) } },
                label = { Text("API address") },
                placeholder = { Text("http://10.0.2.2:3000/v1") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            Hint(
                "The emulator reaches your computer as 10.0.2.2. A physical phone needs your computer's " +
                    "own LAN address on the same Wi-Fi — e.g. http://192.168.1.50:3000/v1. Check it first: " +
                    "that address + /health must open in this phone's browser.",
                tone = Tone.Neutral,
            )
        }

        item { SectionTitle("Sign in", caption = "The owner or manager account that enrols the till.") }
        item {
            OutlinedTextField(
                state.email,
                { v -> vm.update { it.copy(email = v) } },
                label = { Text("Email") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            OutlinedTextField(
                state.password,
                { v -> vm.update { it.copy(password = v) } },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item {
            SectionTitle(
                "Device identifiers",
                caption = "Normally left exactly as generated. Support will give you a branch id for a new till.",
            )
        }
        item {
            OutlinedTextField(
                state.branchId,
                { v -> vm.update { it.copy(branchId = v) } },
                label = { Text("Branch id") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    state.deviceId,
                    { v -> vm.update { it.copy(deviceId = v) } },
                    label = { Text("Device id") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = {
                    vm.update { it.copy(deviceId = java.util.UUID.randomUUID().toString()) }
                }) { Text("New id") }
            }
            Hint("Generate a new device id only before enrolment — changing it afterwards makes this till look like a different device.")
        }

        item {
            Button(
                onClick = { vm.setup() },
                enabled = state.canEnrol,
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Text(
                    when {
                        state.busy -> "Working…"
                        state.configured -> "Re-run setup"
                        else -> "Enrol this device"
                    },
                )
            }
        }
        if (state.busy) item { LoadingState("Talking to the server — do not close the app.") }

        item { SectionTitle("Administration") }
        item {
            NavRow(
                title = "Catalogue",
                subtitle = "Products, prices, barcodes, categories and bulk import",
                icon = Icons.AutoMirrored.Filled.ListAlt,
                onClick = onOpenCatalog,
            )
        }
        item {
            NavRow(
                title = "Licence & plan",
                subtitle = "Import a signed renewal package issued by the vendor",
                icon = Icons.Filled.Verified,
                onClick = onOpenLicense,
            )
        }

        item {
            Hint(
                "The device clock and device permissions are never trusted for financial ordering — " +
                    "the server assigns the canonical order of every transaction.",
            )
        }
    }
}
