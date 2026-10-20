package com.kiosk.erp.feature.inventory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.common.UiTime
import com.kiosk.erp.core.data.repository.InventoryRepository
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.database.ProductConversionEntity
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.database.StockTransferLineEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.DetailRow
import com.kiosk.erp.core.designsystem.EmptyState
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone
import kotlinx.coroutines.launch

private const val OUTGOING = "out"
private const val INCOMING = "in"

/**
 * Cross-branch transfers (item 4.7, ADR 0008): ONE document, TWO per-branch steps.
 *
 * The list is split by direction — what this branch sent and is waiting on, and what is coming to
 * it — because a till only ever sees its own branch's documents, and the two halves are asked of
 * different people at different times. Everything queues: a dispatch is decided at the shelf, a
 * receipt at the delivery door, and neither waits for a connection (§1.6 rule 1).
 *
 * Sync state is carried in words on every row (`Queued`, `Pending on this device`,
 * `Needs attention (code)`, `Last synced …`), never in colour alone (§6).
 */
@Composable
fun TransfersScreen(vm: InventoryViewModel, onBack: () -> Unit) {
    val message by vm.message.collectAsState()
    val rows by vm.transferRows.collectAsState()
    val ownBranchId by vm.ownBranchId.collectAsState()

    var direction by rememberSaveable { mutableStateOf(OUTGOING) }
    var creating by remember { mutableStateOf(false) }
    var receivingId by remember { mutableStateOf<String?>(null) }

    if (creating) {
        CreateTransferScreen(vm = vm, onDone = { creating = false })
        return
    }
    val receivingRow = receivingId?.let { id -> rows.firstOrNull { it.transfer.id == id } }
    if (receivingRow != null) {
        ReceiveTransferScreen(vm = vm, row = receivingRow, onDone = { receivingId = null })
        return
    }

    val visible = remember(rows, direction, ownBranchId) {
        rows.filter { row ->
            if (direction == OUTGOING) row.transfer.fromBranchId == ownBranchId
            else row.transfer.toBranchId == ownBranchId
        }
    }
    val pending = visible.count { it.command?.status.let { s -> s == "pending" || s == "retryable" } }
    val attention = visible.count { it.command?.status.let { s -> s == "rejected" || s == "conflict" || s == "review_required" } }

    Column(Modifier.fillMaxSize().padding(horizontal = ScreenPadding)) {
        ScreenHeader(
            title = "Transfers",
            subtitle = "One document, two steps: this branch sends, the other counts what arrived",
            onBack = onBack,
            actions = {
                IconButton(onClick = vm::refreshTransfers) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh transfers from the server")
                }
            },
        )

        message?.let { text ->
            Banner(
                message = text,
                tone = when {
                    text.startsWith("Cannot") || text.startsWith("Refresh failed") -> Tone.Error
                    text.startsWith("Offline") -> Tone.Warning
                    else -> Tone.Success
                },
                onDismiss = vm::clearMessage,
            )
            Spacer(Modifier.height(StackGap))
        }

        Banner(
            message = "Goods in transit have left this branch's stock and are not yet counted at the destination — they belong to the document, not to either shelf.",
            tone = Tone.Info,
        )

        Spacer(Modifier.height(StackGap))
        Row(horizontalArrangement = Arrangement.spacedBy(StackGap), modifier = Modifier.fillMaxWidth()) {
            Pill(
                text = "Sent from here (${visibleCount(rows, ownBranchId, OUTGOING)})",
                tone = if (direction == OUTGOING) Tone.Info else Tone.Neutral,
                modifier = Modifier.weight(1f).clickable { direction = OUTGOING },
            )
            Pill(
                text = "Coming here (${visibleCount(rows, ownBranchId, INCOMING)})",
                tone = if (direction == INCOMING) Tone.Info else Tone.Neutral,
                modifier = Modifier.weight(1f).clickable { direction = INCOMING },
            )
        }

        if (pending > 0 || attention > 0) {
            Spacer(Modifier.height(StackGap))
            Banner(
                message = listOf(
                    if (pending > 0) "Pending on this device ($pending)" else null,
                    if (attention > 0) "Needs attention ($attention)" else null,
                ).filterNotNull().joinToString("  ·  "),
                tone = if (attention > 0) Tone.Warning else Tone.Info,
            )
        }

        if (direction == OUTGOING && ownBranchId != null) {
            Spacer(Modifier.height(StackGap))
            Button(onClick = { creating = true }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Send stock to another branch")
            }
        }

        Spacer(Modifier.height(StackGap))
        when {
            ownBranchId == null -> EmptyState(
                title = "This device is not enrolled against a branch",
                message = "Transfers are a per-branch document. Set this device's branch up in Settings, then sync to list them.",
                icon = Icons.Filled.SwapHoriz,
            )

            visible.isEmpty() -> EmptyState(
                title = if (direction == OUTGOING) "Nothing sent from here yet" else "Nothing is coming here yet",
                message = if (direction == OUTGOING) {
                    "A transfer is created and dispatched in one step, offline if need be. The destination then counts what arrived and closes the document."
                } else {
                    "Documents this branch has been chosen as the destination of appear here as soon as the source dispatches."
                },
                icon = Icons.Filled.SwapHoriz,
                actionLabel = if (direction == OUTGOING) "Send stock" else null,
                onAction = if (direction == OUTGOING) { { creating = true } } else null,
            )

            else -> LazyColumn(
                verticalArrangement = Arrangement.spacedBy(StackGap),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp),
                modifier = Modifier.weight(1f),
            ) {
                items(visible, key = { it.transfer.id }) { row ->
                    TransferCard(
                        row = row,
                        ownBranchId = ownBranchId,
                        onReceive = { receivingId = row.transfer.id },
                    )
                }
            }
        }
    }
}

/** How many documents a pill counts — the direction filter's own tally. */
private fun visibleCount(rows: List<TransferRow>, ownBranchId: String?, direction: String): Int =
    rows.count { row ->
        if (direction == OUTGOING) row.transfer.fromBranchId == ownBranchId
        else row.transfer.toBranchId == ownBranchId
    }

/** One document: what moved, what arrived, where it is, and what this device last told the server. */
@Composable
private fun TransferCard(row: TransferRow, ownBranchId: String?, onReceive: () -> Unit) {
    val transfer = row.transfer
    val outgoing = transfer.fromBranchId == ownBranchId
    val receivedAt = transfer.receivedAt
    val note = transfer.note
    val approvalNote = transfer.approvalNote
    val receiptQueued = row.command?.status.let { it == "pending" || it == "retryable" }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill(
                    text = when {
                        transfer.status == "received" -> "Received"
                        transfer.status == "discrepancy" -> "Arrived short"
                        outgoing -> "Waiting at destination"
                        else -> "Waiting for your count"
                    },
                    tone = when (transfer.status) {
                        "received" -> Tone.Success
                        "discrepancy" -> Tone.Warning
                        else -> Tone.Info
                    },
                )
                Spacer(Modifier.width(8.dp))
                Pill(
                    text = if (outgoing) "→ ${transfer.toBranchName}" else "← ${transfer.fromBranchName}",
                    tone = Tone.Neutral,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = transfer.reference.ifBlank { "queued on this device" },
                    style = MaterialTheme.typography.titleSmall,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = if (transfer.reference.isBlank()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
            }

            row.lines.forEach { line -> TransferLineRow(line) }

            DetailRow("Dispatched", "${formatWhen(transfer.dispatchedAt)}${if (outgoing) "" else " • from ${transfer.fromBranchName}"}")
            if (receivedAt != null) DetailRow("Counted here", formatWhen(receivedAt))
            if (note != null) DetailRow("Note", note)
            if (approvalNote != null) DetailRow("Supervisor note", approvalNote)

            SyncStateLine(command = row.command, synced = transfer.synced)

            if (!outgoing && transfer.status == "dispatched") {
                if (receiptQueued) {
                    Pill(text = "Receipt queued — pending on this device", tone = Tone.Info)
                } else {
                    Button(onClick = onReceive, modifier = Modifier.fillMaxWidth()) { Text("Count what arrived") }
                }
            }
        }
    }
}

/** One line: what was written on the paperwork, what left, what arrived — and how far it came up short. */
@Composable
private fun TransferLineRow(line: StockTransferLineEntity) {
    val received = line.received
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(
                text = line.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val entered = line.enteredQuantity
            val enteredUnit = line.enteredUnit
            Text(
                text = buildString {
                    append(line.sku)
                    if (entered != null && enteredUnit != null) append(" • wrote ${Units.formatQuantity(entered)} $enteredUnit")
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = "sent ${Units.formatQuantity(line.dispatched)} ${line.unit}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
            )
            when {
                received == null -> Text(
                    text = "not counted yet",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                line.shortage > 0.0 -> Text(
                    text = "counted ${Units.formatQuantity(received)} — ${Units.formatQuantity(line.shortage)} short",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.error,
                )

                else -> Text(
                    text = "counted ${Units.formatQuantity(received)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

/**
 * What this device most recently told the server about this document, in the words the sync state
 * vocabulary mandates (§6): a green tick or a bare "synced" icon would say nothing about WHY a
 * document is not on the server yet, so the state itself is the text.
 */
@Composable
private fun SyncStateLine(command: OutboxEntity?, synced: Boolean) {
    val status = command?.status
    when {
        status == null -> Pill(
            text = if (synced) "Known to the server" else "Not on the server yet",
            tone = if (synced) Tone.Success else Tone.Neutral,
        )

        status == "pending" -> Pill(text = "Queued — pending on this device", tone = Tone.Info)
        status == "retryable" -> Pill(text = "Queued for retry — pending on this device", tone = Tone.Warning)

        status == "accepted" || status == "duplicate" -> Pill(
            text = command.syncedAtEpochMs?.let { "Last synced ${UiTime.timeAgo(it)}" } ?: "Synced with the server",
            tone = Tone.Success,
        )

        status == "review_required" -> AttentionLine(
            label = "Needs attention — ${command.conflictCode ?: "review"}",
            tone = Tone.Warning,
            detail = command.lastError ?: "The server posted it and wants a supervisor's eye on it.",
        )

        status == "rejected" || status == "conflict" -> AttentionLine(
            label = "Needs attention — ${command.conflictCode ?: status}",
            tone = Tone.Error,
            detail = (command.lastError ?: "The server refused this command.") +
                if (!synced) " The goods did not move — correct it and send it again." else "",
        )

        else -> Pill(text = status, tone = Tone.Neutral)
    }
}

@Composable
private fun AttentionLine(label: String, tone: Tone, detail: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Pill(text = label, tone = tone)
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// --- creating + dispatching (the source half) ----------------------------------------------------

/**
 * Build and dispatch a transfer from this branch: destination, lines written in the unit the shelf
 * counts in (packs previewed with the same conversion the server posts with), an optional note, and
 * the supervisor note the server demands when the dispatch would take this branch below zero.
 *
 * The whole screen works from caches — products, packs, balances and the branch list — so the
 * decision is made at the shelf with the network down, and only the queueing waits for a signal.
 */
@Composable
private fun CreateTransferScreen(vm: InventoryViewModel, onDone: () -> Unit) {
    val products by vm.products.collectAsState()
    val balances by vm.balances.collectAsState()
    val branches by vm.branches.collectAsState()
    val ownBranchId by vm.ownBranchId.collectAsState()
    val matches by vm.lineMatches.collectAsState()
    val packs by vm.packLookup.collectAsState()

    var destinationId by remember { mutableStateOf<String?>(null) }
    var draftLines by remember { mutableStateOf<List<InventoryRepository.TransferLineDraft>>(emptyList()) }
    var code by rememberSaveable { mutableStateOf("") }
    var miss by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf<ProductEntity?>(null) }
    var note by rememberSaveable { mutableStateOf("") }
    var approvalNote by rememberSaveable { mutableStateOf("") }

    val scope = rememberCoroutineScope()
    val quantityByProduct = remember(balances) { balances.associate { it.productId to it.quantity } }
    val destinations = remember(branches, ownBranchId) { branches.filter { it.id != ownBranchId } }
    val destination = destinations.firstOrNull { it.id == destinationId }

    // Would ANY product's dispatch leave this branch below zero? The server checks the authoritative
    // on-hand; this is the device's cached read of the same question, asked before the operator
    // types a note they will be asked for anyway (§3.D).
    val shortfall = remember(draftLines, quantityByProduct) {
        draftLines
            .groupBy { it.productId }
            .filter { (productId, lines) ->
                val onHand = quantityByProduct[productId]
                onHand != null && lines.sumOf { it.baseQuantity } > onHand
            }
            .keys
    }
    val needsApprovalNote = shortfall.isNotEmpty()
    val canDispatch = destination != null && draftLines.isNotEmpty() && (!needsApprovalNote || approvalNote.isNotBlank())

    fun addFromCode() {
        val typed = code.trim()
        if (typed.isEmpty()) return
        scope.launch {
            val found = vm.findProduct(typed)
            if (found != null) {
                code = ""
                miss = null
                vm.searchLines("")
                picking = found
            } else {
                miss = "No product matches \"$typed\" — check the spelling or scan the tag again"
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = ScreenPadding)) {
        ScreenHeader(
            title = "Send stock",
            subtitle = "Created and dispatched as ONE document — the other branch counts it against the same number",
            onBack = onDone,
        )
        Spacer(Modifier.height(StackGap))

        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(StackGap),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp),
            modifier = Modifier.weight(1f),
        ) {
            item {
                SectionTitle("Destination", caption = "Branches are cached from the server, so this list works offline")
                if (destinations.isEmpty()) {
                    Hint("No other branch is known to this device yet — sync once (pull to refresh on Stock) and the tenant's branches will appear here.", tone = Tone.Warning)
                }
                destinations.forEach { branch ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { destinationId = branch.id },
                    ) {
                        RadioButton(selected = destinationId == branch.id, onClick = { destinationId = branch.id })
                        Column {
                            Text(branch.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(
                                "${branch.code} • goods arrive as ${branch.name}'s stock",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item {
                SectionTitle("Lines", caption = "Scan a barcode or type a code — a scanner's Enter adds it")
                Spacer(Modifier.height(StackGap))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it; miss = null },
                    label = { Text("Scan or type a barcode or SKU") },
                    placeholder = { Text("e.g. 6001000000011") },
                    singleLine = true,
                    trailingIcon = {
                        IconButton(onClick = { addFromCode() }) { Icon(Icons.Filled.Add, contentDescription = "Add this code") }
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { addFromCode() }),
                    modifier = Modifier.fillMaxWidth(),
                )
                miss?.let { Hint(it, tone = Tone.Error) }
                matches.take(6).forEach { product ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable {
                            code = ""
                            miss = null
                            vm.searchLines("")
                            picking = product
                        },
                    ) {
                        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                            Text(product.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                "${product.sku} • ${quantityByProduct[product.id]?.let { "${Units.formatQuantity(it)} ${product.unit} on hand" } ?: "not cached"}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Pill("Add", Tone.Info)
                    }
                }
            }

            if (draftLines.isNotEmpty()) {
                item { SectionTitle("Sending (${draftLines.size})", caption = "Tap a line to change its quantity") }
                items(draftLines.size) { index ->
                    val line = draftLines[index]
                    DraftLineCard(
                        line = line,
                        onHand = quantityByProduct[line.productId],
                        onEdit = { picking = lineProduct(products, line.productId) ?: picking },
                        onRemove = { draftLines = draftLines.filterNot { it.productId == line.productId } },
                    )
                }
            }

            item {
                if (needsApprovalNote) {
                    Banner(
                        message = "This would take ${shortfall.joinToString()} below zero on the cached balance. The server refuses a dispatch that empties the shelf unless a supervisor says why — the note below becomes part of the document.",
                        tone = Tone.Warning,
                    )
                    Spacer(Modifier.height(StackGap))
                    OutlinedTextField(
                        value = approvalNote,
                        onValueChange = { approvalNote = it },
                        label = { Text("Supervisor note (required)") },
                        placeholder = { Text("why this branch may go below zero") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(StackGap))
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("Note for the receiving branch (optional)") },
                    placeholder = { Text("e.g. restock for the weekend") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(StackGap))
                Button(
                    onClick = {
                        destination?.let { chosen ->
                            vm.dispatch(
                                toBranchId = chosen.id,
                                toBranchName = chosen.name,
                                lines = draftLines,
                                note = note,
                                approvalNote = approvalNote,
                            )
                            draftLines = emptyList()
                            note = ""
                            approvalNote = ""
                            onDone()
                        }
                    },
                    enabled = canDispatch,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (draftLines.isEmpty()) "Add at least one line" else "Dispatch ${draftLines.size} line(s) to ${destination?.name ?: "…"}")
                }
                Hint("Queued offline if there is no signal: the document number appears when the server issues it from its series.")
            }
        }
    }

    picking?.let { product ->
        LaunchedEffect(product.id) { vm.loadPacks(product) }
        LineQuantityDialog(
            product = product,
            onHand = quantityByProduct[product.id],
            packs = packs,
            initial = draftLines.firstOrNull { it.productId == product.id },
            onDismiss = { picking = null },
            onConfirm = { entered, unit, base ->
                val line = InventoryRepository.TransferLineDraft(
                    productId = product.id,
                    sku = product.sku,
                    name = product.name,
                    baseUnit = product.unit,
                    enteredQuantity = entered,
                    enteredUnit = unit,
                    baseQuantity = base,
                )
                // Replacing, not appending: a product appears once on a document (the server's
                // UNIQUE (transfer_id, product_id) says the same thing), so editing a line is the
                // same operation as adding it again.
                draftLines = draftLines.filterNot { it.productId == product.id } + line
                picking = null
            },
        )
    }
}

private fun lineProduct(products: List<ProductEntity>, productId: String): ProductEntity? =
    products.firstOrNull { it.id == productId }

/** A queued line: what was written, what it is in base units, and what it leaves behind. */
@Composable
private fun DraftLineCard(
    line: InventoryRepository.TransferLineDraft,
    onHand: Double?,
    onEdit: () -> Unit,
    onRemove: () -> Unit,
) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onEdit)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(line.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    buildString {
                        append(line.sku)
                        append(" • ")
                        append("${Units.formatQuantity(line.enteredQuantity)} ${line.enteredUnit ?: line.baseUnit}")
                        if (line.enteredUnit != null) append(" = ${Units.formatQuantity(line.baseQuantity)} ${line.baseUnit}")
                        append(" • ")
                        append(onHand?.let {
                            "on hand ${Units.formatQuantity(it)}, left ${Units.formatQuantity(it - line.baseQuantity)}"
                        } ?: "on hand not cached")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onRemove) {
                Icon(Icons.Filled.Clear, contentDescription = "Remove ${line.name} from this transfer")
            }
        }
    }
}

/**
 * Quantity for one line, in the unit the shelf counts in. The conversion shown here is the
 * device's PREVIEW using the same reference implementation the server posts with; the command
 * carries what was TYPED and the server derives the base quantity itself (item 4.6/4.7).
 */
@Composable
private fun LineQuantityDialog(
    product: ProductEntity,
    onHand: Double?,
    packs: List<ProductConversionEntity>,
    initial: InventoryRepository.TransferLineDraft?,
    onDismiss: () -> Unit,
    onConfirm: (entered: Double, unit: String?, base: Double) -> Unit,
) {
    var quantityText by remember(product.id) { mutableStateOf(initial?.let { plainNumber(it.enteredQuantity) } ?: "") }
    var unit by remember(product.id) { mutableStateOf(initial?.enteredUnit ?: product.unit) }

    val quantity = quantityText.trim().toDoubleOrNull()
    val kind = product.unitKind
    val isBase = unit.equals(product.unit, ignoreCase = true)
    val packFactor = packs.firstOrNull { it.unit.equals(unit, ignoreCase = true) }?.factor

    val converted: Units.ConvertResult? = when {
        quantity == null -> null
        isBase -> kind?.let { Units.convertQuantity(quantity, 1.0, 1.0, it) } ?: Units.ConvertResult.Ok(Units.roundQuantity(quantity))
        packFactor == null -> Units.ConvertResult.Failed("UNKNOWN_CONVERSION")
        kind == null -> Units.ConvertResult.Failed("UNKNOWN_UNIT_KIND")
        else -> Units.convertQuantity(quantity, packFactor, 1.0, kind)
    }
    val base = (converted as? Units.ConvertResult.Ok)?.quantity
    val failure = (converted as? Units.ConvertResult.Failed)?.code
    val canConfirm = base != null && base > 0.0
    val wouldExceed = base != null && onHand != null && base > onHand
    val options = remember(product.id, packs) { (listOf(product.unit) + packs.map { it.unit }).distinctBy { it.lowercase() } }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "Add ${product.name}" else "Change ${product.name}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                DetailRow("SKU", product.sku, monospace = true)
                DetailRow("On hand (cached)", onHand?.let { "${Units.formatQuantity(it)} ${product.unit}" } ?: "not cached yet")

                if (options.size > 1) {
                    Spacer(Modifier.height(StackGap))
                    Text("Send in", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    options.forEach { option ->
                        val selected = option.equals(unit, ignoreCase = true)
                        val pack = packs.firstOrNull { it.unit.equals(option, ignoreCase = true) }
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().clickable { unit = option },
                        ) {
                            RadioButton(selected = selected, onClick = { unit = option })
                            Text(
                                if (pack == null) "$option — stock is held in this"
                                else "1 $option = ${Units.formatQuantity(pack.factor)} ${product.unit}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(StackGap))
                OutlinedTextField(
                    quantityText,
                    { quantityText = it },
                    label = { Text("Quantity to send ($unit)") },
                    placeholder = { Text("e.g. 2") },
                    singleLine = true,
                    isError = quantityText.isNotBlank() && quantity == null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (failure != null) {
                    Spacer(Modifier.height(6.dp))
                    Hint(conversionProblem(failure, unit, product.unit), tone = Tone.Error)
                } else if (quantity != null && base != null) {
                    Spacer(Modifier.height(6.dp))
                    if (!isBase) {
                        Text(
                            "${Units.formatQuantity(quantity)} $unit = ${Units.formatQuantity(base)} ${product.unit}",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    Text(
                        "→ ${Units.formatQuantity(base)} ${product.unit} will leave this branch",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (wouldExceed) {
                    Spacer(Modifier.height(StackGap))
                    Banner(
                        message = "That is more than the cached on hand for this branch. The server refuses a dispatch that empties the shelf without a supervisor note — the dispatch form will ask for one.",
                        tone = Tone.Warning,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val entered = quantity
                    val baseQuantity = base
                    if (entered != null && baseQuantity != null) onConfirm(entered, if (isBase) null else unit, baseQuantity)
                },
                enabled = canConfirm,
            ) { Text(if (initial == null) "Add line" else "Update line") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// --- receiving (the destination half) ------------------------------------------------------------

/**
 * Count what arrived. Every dispatched line is prefilled with what was sent, because a missing line
 * is a stale receipt and an invented one is somebody else's goods — the server refuses both. A
 * shortage needs the supervisor note before the count will post at all (§3.D, owner decision), and a
 * surplus is refused outright: receiving more than was sent is a supplier receipt, not a transfer.
 */
@Composable
private fun ReceiveTransferScreen(vm: InventoryViewModel, row: TransferRow, onDone: () -> Unit) {
    val transfer = row.transfer
    var counts by remember(transfer.id) {
        mutableStateOf(row.lines.associate { it.productId to plainNumber(it.dispatched) })
    }
    var approvalNote by rememberSaveable(transfer.id) { mutableStateOf("") }

    val parsed = row.lines.associate { line ->
        line.productId to (counts[line.productId]?.trim()?.toDoubleOrNull() ?: Double.NaN)
    }
    val allValid = parsed.values.all { !it.isNaN() && it >= 0.0 }
    val overReceived = row.lines.filter { line -> (parsed[line.productId] ?: 0.0) > line.dispatched }
    // NaN-safe: an unparseable field contributes no shortage — `allValid` is what blocks the button.
    val shortage = row.lines.sumOf { line ->
        val counted = parsed[line.productId]
        if (counted == null || counted.isNaN()) 0.0 else Math.max(line.dispatched - counted, 0.0)
    }
    val totalSent = row.lines.sumOf { it.dispatched }
    val totalCounted = parsed.values.sumOf { if (it.isNaN()) 0.0 else it }
    val needsNote = shortage > 0.0
    val canReceive = allValid && overReceived.isEmpty() && (!needsNote || approvalNote.isNotBlank())

    Column(Modifier.fillMaxSize().padding(horizontal = ScreenPadding)) {
        ScreenHeader(
            title = transfer.reference.ifBlank { "Count what arrived" },
            subtitle = "from ${transfer.fromBranchName} • dispatched ${formatWhen(transfer.dispatchedAt)}",
            onBack = onDone,
        )
        Spacer(Modifier.height(StackGap))

        Banner(
            message = "Count each line as it comes off the delivery. A shortage needs a supervisor note before the server will accept it; receiving MORE than was sent is refused — that belongs on a supplier receipt.",
            tone = Tone.Info,
        )
        Spacer(Modifier.height(StackGap))

        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(StackGap),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp),
            modifier = Modifier.weight(1f),
        ) {
            items(row.lines, key = { it.productId }) { line ->
                val value = counts[line.productId] ?: plainNumber(line.dispatched)
                val number = value.trim().toDoubleOrNull()
                val over = number != null && number > line.dispatched
                val short = number != null && number < line.dispatched

                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = line.name,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = buildString {
                                append("${line.sku} • sent ${Units.formatQuantity(line.dispatched)} ${line.unit}")
                                val entered = line.enteredQuantity
                                val enteredUnit = line.enteredUnit
                                if (entered != null && enteredUnit != null) append(" (${Units.formatQuantity(entered)} $enteredUnit)")
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = value,
                            onValueChange = { counts = counts + (line.productId to it) },
                            label = { Text("Counted (${line.unit})") },
                            singleLine = true,
                            isError = number == null || over,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            supportingText = {
                                Text(
                                    when {
                                        number == null -> "Enter a number — every dispatched line must be accounted for"
                                        over -> "More than was sent is refused — a surplus belongs on a supplier receipt"
                                        short -> "Short by ${Units.formatQuantity(line.dispatched - number)} ${line.unit}"
                                        else -> "Matches what was sent"
                                    },
                                )
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            item {
                DetailRow("Sent in total", Units.formatQuantity(totalSent))
                DetailRow("Counted in total", Units.formatQuantity(totalCounted))
                if (needsNote) DetailRow("Short by", Units.formatQuantity(shortage))
                Spacer(Modifier.height(StackGap))
                if (needsNote) {
                    Banner(
                        message = "This receipt is short ${Units.formatQuantity(shortage)} unit(s) across ${row.lines.count { (parsed[it.productId] ?: 0.0) < it.dispatched }} line(s). The server accepts a short receipt only with a supervisor's note explaining it.",
                        tone = Tone.Warning,
                    )
                    Spacer(Modifier.height(StackGap))
                    OutlinedTextField(
                        value = approvalNote,
                        onValueChange = { approvalNote = it },
                        label = { Text("Supervisor note (required)") },
                        placeholder = { Text("why the count came up short") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(StackGap))
                }
                Button(
                    onClick = {
                        val numbers = parsed.mapValues { (_, value) -> if (value.isNaN()) 0.0 else value }
                        vm.receive(transfer = transfer, received = numbers, approvalNote = approvalNote)
                        onDone()
                    },
                    enabled = canReceive,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (needsNote) "Queue receipt with shortage note" else "Queue receipt")
                }
                Hint("Queues offline: the document closes for BOTH branches once the server has this count.")
            }
        }
    }
}

/** 3, not 3.0 — the shape every quantity field starts with. */
private fun plainNumber(value: Double): String =
    if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()
