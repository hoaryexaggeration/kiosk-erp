package com.kiosk.erp.feature.dashboard

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.common.UiTime
import com.kiosk.erp.core.database.SaleEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.DetailRow
import com.kiosk.erp.core.designsystem.EmptyState
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.StatTile
import com.kiosk.erp.core.designsystem.Tone

@Composable
fun DashboardScreen(
    vm: DashboardViewModel,
    onOpenPos: () -> Unit = {},
    onOpenSync: () -> Unit = {},
    onOpenSetup: () -> Unit = {},
) {
    val accepted by vm.acceptedTotalMinor.collectAsState()
    val pendingTotal by vm.pendingTotalMinor.collectAsState()
    val saleCount by vm.saleCount.collectAsState()
    val pending by vm.pendingCount.collectAsState()
    val attention by vm.attentionCount.collectAsState()
    val sync by vm.syncState.collectAsState()
    val sales by vm.recentSales.collectAsState()
    val session by vm.session.collectAsState()

    val reachable = sync?.serverReachable == true
    val statusTone = when {
        attention > 0 -> Tone.Error
        pending > 0 -> Tone.Warning
        reachable -> Tone.Success
        else -> Tone.Neutral
    }
    val statusText = when {
        attention > 0 -> "Needs attention"
        pending > 0 && !reachable -> "Offline · $pending waiting"
        pending > 0 -> "$pending waiting to upload"
        reachable -> "Up to date"
        else -> "Not connected"
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(StackGap),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            ScreenHeader(
                title = "Home",
                subtitle = "Offline-first point of sale · local first, reconciled to the cloud",
            )
        }

        if (session?.canSync != true) {
            item {
                Banner(
                    message = "This device is not enrolled yet, so nothing it records can be uploaded. Open Setup to bind it to your branch.",
                    tone = Tone.Warning,
                    icon = Icons.Filled.Warning,
                    actionLabel = "Set up",
                    onAction = onOpenSetup,
                )
            }
        }

        // §7: provisional money is shown, but named as provisional and kept beside the posted figure.
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
                StatTile(
                    label = "Accepted by the server",
                    value = "${Pricing.formatMinor(accepted)} KES",
                    caption = "posted sales total",
                    tone = Tone.Success,
                    modifier = Modifier.weight(1f),
                )
                StatTile(
                    label = "Waiting to upload",
                    value = "${Pricing.formatMinor(pendingTotal)} KES",
                    caption = if (pending > 0) "$pending command(s) on this device" else "nothing queued",
                    tone = if (pending > 0) Tone.Warning else Tone.Neutral,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Pill(statusText, statusTone, icon = when (statusTone) {
                            Tone.Success -> Icons.Filled.CheckCircle
                            Tone.Error -> Icons.Filled.ErrorOutline
                            Tone.Warning -> Icons.Filled.Warning
                            else -> null
                        })
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = onOpenSync) { Text("Sync Center") }
                    }
                    Spacer(Modifier.height(4.dp))
                    DetailRow("Needs attention", if (attention == 0) "none" else "$attention command(s) rejected or conflicted")
                    DetailRow("Last sync", UiTime.timeAgo(sync?.lastPushAtEpochMs))
                    DetailRow("Connection", if (reachable) "Server reachable" else "No connection to the server")
                    sync?.lastError?.takeIf { it.isNotBlank() }?.let { error ->
                        DetailRow("Last error", error)
                    }
                }
            }
        }

        item {
            SectionTitle("Recent sales", caption = "$saleCount recorded on this device in total")
        }

        if (sales.isEmpty()) {
            item {
                EmptyState(
                    title = "No sales yet",
                    message = "The first sale appears here with its sync state, so you can always see whether it reached the server.",
                    icon = Icons.Filled.PointOfSale,
                    actionLabel = "Open the till",
                    onAction = onOpenPos,
                )
            }
        } else {
            items(sales, key = { it.id }) { sale -> SaleRow(sale) }
        }
    }
}

@Composable
private fun SaleRow(sale: SaleEntity) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(sale.localNumber, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "${UiTime.format(sale.createdAtEpochMs)} • ${UiTime.timeAgo(sale.createdAtEpochMs)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "${Pricing.formatMinor(sale.totalMinor)} KES",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(2.dp))
                Pill(saleStateLabel(sale.state), saleStateTone(sale.state))
            }
        }
    }
}

/** Sale states come from the fixture state machine; the operator reads words, not codes. */
private fun saleStateLabel(state: String): String = when (state) {
    "pending_sync" -> "Waiting"
    "accepted" -> "Accepted"
    "review_required" -> "Needs review"
    "rejected" -> "Rejected"
    "conflict" -> "Conflict"
    else -> state.ifBlank { "Unknown" }
}

private fun saleStateTone(state: String): Tone = when (state) {
    "accepted" -> Tone.Success
    "pending_sync" -> Tone.Warning
    "review_required", "conflict" -> Tone.Error
    "rejected" -> Tone.Error
    else -> Tone.Neutral
}
