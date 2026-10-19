package com.kiosk.erp.feature.sync

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
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.UiTime
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.DetailRow
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone

/**
 * The Sync Centre.
 *
 * It answers the question a shopkeeper actually asks — *is my data safe, and is it uploaded?* —
 * before it shows anything technical. Connection and queue are reported as two separate facts on
 * purpose (§16): a device can have internet and still be holding a failed queue, and a green
 * network icon alone would say nothing about that.
 */
@Composable
fun SyncCenterScreen(vm: SyncViewModel) {
    val pending by vm.pendingCount.collectAsState()
    val pendingEntries by vm.pendingEntries.collectAsState()
    val attention by vm.attention.collectAsState()
    val sync by vm.syncState.collectAsState()
    val oldest by vm.oldestPending.collectAsState()
    val message by vm.message.collectAsState()
    val syncing by vm.syncing.collectAsState()

    val reachable = sync?.serverReachable == true
    val statusTone = when {
        attention.isNotEmpty() -> Tone.Error
        pending > 0 -> Tone.Warning
        reachable && sync != null -> Tone.Success
        else -> Tone.Neutral
    }
    val statusText = when {
        attention.isNotEmpty() -> "${attention.size} need attention"
        pending > 0 && !reachable -> "Offline · $pending waiting"
        pending > 0 -> "$pending waiting to upload"
        reachable && sync != null -> "Up to date"
        else -> "Not synced yet"
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(StackGap),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            ScreenHeader(
                title = "Sync Center",
                subtitle = "What this device is holding, and what the server has accepted",
            )
        }

        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Pill(
                        statusText,
                        statusTone,
                        icon = when (statusTone) {
                            Tone.Success -> Icons.Filled.CheckCircle
                            Tone.Error -> Icons.Filled.ErrorOutline
                            Tone.Warning -> if (pending > 0) Icons.Filled.Sync else Icons.Filled.Warning
                            else -> null
                        },
                    )
                    Spacer(Modifier.height(10.dp))
                    DetailRow("Waiting to upload", if (pending == 0) "nothing" else "$pending command(s) · oldest ${UiTime.timeAgo(oldest)}")
                    DetailRow("Needs attention", if (attention.isEmpty()) "none" else "${attention.size} — see below")
                    DetailRow("Connection", if (reachable) "Server reachable" else "No connection to the server")
                    DetailRow("Last sync", UiTime.timeAgo(sync?.lastPushAtEpochMs))
                    sync?.lastError?.takeIf { it.isNotBlank() }?.let { DetailRow("Last error", it) }
                }
            }
        }

        item {
            Hint("Connection and queue are separate on purpose: a device can be online and still be holding work that has not uploaded.")
        }

        item {
            Button(
                onClick = { vm.syncNow() },
                enabled = !syncing,
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) { Text(if (syncing) "Syncing…" else "Sync now") }
        }

        message?.let { text ->
            item {
                Banner(
                    message = text,
                    tone = if (text.startsWith("Sync failed") || text.startsWith("This device")) Tone.Error else Tone.Success,
                    onDismiss = vm::clearMessage,
                )
            }
        }

        // Never dismissed silently: a rejected or conflicted command keeps its place until a person
        // has seen it (§6 conflict handling).
        item {
            SectionTitle(
                "Needs attention",
                caption = if (attention.isEmpty()) "Nothing is stuck." else "These were rejected or conflicted — nothing was lost, but nothing will retry on its own either.",
            )
        }
        items(attention, key = { it.commandId }) { entry -> AttentionRow(entry) }

        item {
            SectionTitle(
                "Waiting to upload",
                caption = if (pending == 0) "Nothing queued." else "Held safely on this device until the server accepts it.",
            )
        }
        if (pendingEntries.isEmpty()) {
            item { Hint("Commands appear here the moment they are recorded, then move to \"Needs attention\" only if the server refuses them.") }
        } else {
            items(pendingEntries.take(10), key = { it.commandId }) { entry -> PendingRow(entry) }
            if (pendingEntries.size > 10) {
                item { Hint("…and ${pendingEntries.size - 10} more not shown.") }
            }
        }

        item { SectionTitle("Diagnostics", caption = "For support only — safe to ignore in normal use.") }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    DetailRow("Sync cursor", "${sync?.cursor ?: 0}")
                    DetailRow("Device", sync?.let { "seen ${UiTime.timeAgo(it.lastPullAtEpochMs)}" } ?: "never")
                    Spacer(Modifier.height(6.dp))
                    Button(onClick = { vm.createTestCommand() }, modifier = Modifier.fillMaxWidth()) {
                        Text("Write an offline test command")
                    }
                    Spacer(Modifier.height(4.dp))
                    Hint("Writes a tiny sale straight to the local queue so a sync can be watched end to end without a customer waiting.")
                }
            }
        }
    }
}

@Composable
private fun PendingRow(entry: OutboxEntity) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(aggregateLabel(entry.aggregateType), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "recorded ${UiTime.timeAgo(entry.createdAtEpochMs)} • ${UiTime.format(entry.createdAtEpochMs)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Pill("Waiting", Tone.Warning, icon = Icons.Filled.Sync)
        }
    }
}

@Composable
private fun AttentionRow(entry: OutboxEntity) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    aggregateLabel(entry.aggregateType),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Pill(
                    when (entry.status) {
                        "conflict" -> "Conflict"
                        "review_required" -> "Needs review"
                        else -> "Rejected"
                    },
                    Tone.Error,
                    icon = Icons.Filled.ErrorOutline,
                )
            }
            Text(
                entry.aggregateId.take(8),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            entry.lastError?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            }
            explainConflict(entry.conflictCode)?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (entry.attempts > 0) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "${entry.attempts} attempt(s) • last tried ${UiTime.timeAgo(entry.syncedAtEpochMs)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun aggregateLabel(aggregateType: String): String = when (aggregateType) {
    "Sale" -> "Sale"
    "StockReceipt" -> "Stock receipt"
    "StockAdjustment" -> "Stock adjustment"
    else -> aggregateType
}

/** Turn a machine conflict code into the next action a person can actually take. */
private fun explainConflict(code: String?): String? = when (code) {
    "NEGATIVE_STOCK" -> "That change would take stock below zero. Check the count first; a decrease below zero also needs a supervisor's reason."
    "VERSION_MISMATCH" -> "Someone changed the same record first. Reopen it and enter the change again."
    "STALE_PRICE_SNAPSHOT" -> "The price changed while this was queued. Reopen the sale and confirm the current price."
    "UNSUPPORTED_AGGREGATE" -> "This version of the server does not accept that kind of command yet — check for an app update."
    "FORBIDDEN" -> "Your role does not allow this action. Ask the owner to make the change."
    "OFFLINE_PERMISSION_EXPIRED" -> "The offline permission expired. Connect and sign in again from Setup."
    "UNAUTHENTICATED" -> "The session expired. Sign in again from Setup."
    "DUPLICATE_PROVIDER_REF" -> "This reference has already been recorded."
    else -> null
}
