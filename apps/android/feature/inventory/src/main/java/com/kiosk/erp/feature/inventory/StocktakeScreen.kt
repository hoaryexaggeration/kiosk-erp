package com.kiosk.erp.feature.inventory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FactCheck
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.data.repository.InventoryRepository
import com.kiosk.erp.core.database.ProductConversionEntity
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.EmptyState
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone
import kotlinx.coroutines.launch

/** Float dust is not a disagreement: 2.3 counted against 2.3000000000000004 agrees with the book. */
private const val VARIANCE_EPSILON = 1e-9

/**
 * Stocktake / cycle count (item 4.8, §3.D).
 *
 * The sheet is built the way a shelf is counted: scan a product onto it, then type what was read.
 * What goes up to the server is the COUNT, never a plus or minus — the variance is derived per line
 * against the server's own book, so a till whose cached balance has drifted cannot decide where the
 * shelf lands (§6). A line that agrees with the book is still counted (it is an assertion), and the
 * server writes nothing for it, which is what keeps the movement ledger a list of things that
 * happened. A blank line is a shelf nobody counted yet and stays behind.
 *
 * A count cannot be negative — you cannot count −2 bottles — and unlike an adjustment it can never
 * push stock below zero, so it asks for no supervisor note: the refusals here are about a number
 * that was never a number.
 */
@Composable
fun StocktakeScreen(vm: InventoryViewModel, onBack: () -> Unit) {
    val message by vm.message.collectAsState()
    val balances by vm.balances.collectAsState()
    val products by vm.products.collectAsState()
    val matches by vm.lineMatches.collectAsState()
    val sheetPacks by vm.sheetPacks.collectAsState()

    var lines by remember { mutableStateOf<List<CountLine>>(emptyList()) }
    var code by rememberSaveable { mutableStateOf("") }
    var miss by remember { mutableStateOf<String?>(null) }
    var note by rememberSaveable { mutableStateOf("") }

    val quantityByProduct = remember(balances) { balances.associate { it.productId to it.quantity } }
    val sheetProductIds = remember(lines) { lines.map { it.product.id }.toSet() }
    LaunchedEffect(sheetProductIds) { vm.loadSheetPacks(sheetProductIds) }
    val scope = rememberCoroutineScope()

    /** One line per product, exactly like a document: counting a product again replaces its line. */
    fun addProduct(product: ProductEntity) {
        code = ""
        miss = null
        vm.searchLines("")
        lines = lines.filterNot { it.product.id == product.id } + CountLine(product, "", product.unit)
    }

    fun addFromCode() {
        val typedCode = code.trim()
        if (typedCode.isEmpty()) return
        scope.launch {
            val found = vm.findProduct(typedCode)
            if (found != null) addProduct(found)
            else miss = "No product matches \"$typedCode\" — check the spelling or scan the tag again"
        }
    }

    fun countAllWithStock() {
        val onSheet = lines.map { it.product.id }.toSet()
        // Only what this branch physically holds can be pre-filled: a shelf with nothing on it is
        // counted by scanning the product specifically, because "found stock" is a real outcome a
        // full sheet cannot guess at.
        val additions = products
            .filter { it.isStockTracked && it.id !in onSheet && (quantityByProduct[it.id] ?: 0.0) > 0.0 }
            .sortedBy { it.name.lowercase() }
            .map { CountLine(it, "", it.unit) }
        lines = lines + additions
    }

    /** What one typed field means: the count in base units, or why it cannot be one. */
    fun countedBase(line: CountLine): Units.ConvertResult? {
        val entered = line.counted.trim().toDoubleOrNull() ?: return null
        val isBase = line.unit.equals(line.product.unit, ignoreCase = true)
        val packFactor = sheetPacks[line.product.id]?.firstOrNull { it.unit.equals(line.unit, ignoreCase = true) }?.factor
        val kind = line.product.unitKind
        return when {
            isBase -> kind?.let { Units.convertQuantity(entered, 1.0, 1.0, it) } ?: Units.ConvertResult.Ok(Units.roundQuantity(entered))
            packFactor == null -> Units.ConvertResult.Failed("UNKNOWN_CONVERSION")
            kind == null -> Units.ConvertResult.Failed("UNKNOWN_UNIT_KIND")
            else -> Units.convertQuantity(entered, packFactor, 1.0, kind)
        }
    }

    // Lines the operator actually wrote a number for — these are what goes up. Blank lines are
    // shelves nobody counted yet, and stay behind on the sheet.
    val typed = lines.filter { it.counted.isNotBlank() }
    val invalid = typed.filter { line ->
        val entered = line.counted.trim().toDoubleOrNull()
        entered == null || entered < 0.0 || (countedBase(line) as? Units.ConvertResult.Ok) == null
    }
    val drafts = typed
        .filter { it !in invalid }
        .mapNotNull { line ->
            val entered = line.counted.trim().toDoubleOrNull() ?: return@mapNotNull null
            val base = (countedBase(line) as? Units.ConvertResult.Ok)?.quantity ?: return@mapNotNull null
            InventoryRepository.StocktakeLineDraft(
                productId = line.product.id,
                sku = line.product.sku,
                name = line.product.name,
                enteredQuantity = entered,
                enteredUnit = line.unit.takeIf { !it.equals(line.product.unit, ignoreCase = true) },
                baseQuantity = base,
            )
        }
    val varianceLines = drafts.count { draft ->
        val book = quantityByProduct[draft.productId] ?: 0.0
        Math.abs(draft.baseQuantity - book) >= VARIANCE_EPSILON
    }
    val canQueue = drafts.isNotEmpty() && invalid.isEmpty()

    Column(Modifier.fillMaxSize().padding(horizontal = ScreenPadding)) {
        ScreenHeader(
            title = "Stocktake",
            subtitle = "Count what is on the shelf — a line that agrees with the book writes nothing",
            onBack = onBack,
        )

        message?.let { text ->
            Banner(
                message = text,
                tone = when {
                    text.startsWith("Cannot") -> Tone.Error
                    text.startsWith("Offline") -> Tone.Warning
                    else -> Tone.Success
                },
                onDismiss = vm::clearMessage,
            )
            Spacer(Modifier.height(StackGap))
        }

        Banner(
            message = "The count goes up as what you READ, never as a plus or minus: the server works out the variance against its own book, so a till that has drifted cannot decide where the shelf lands.",
            tone = Tone.Info,
        )

        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(StackGap),
            contentPadding = PaddingValues(bottom = 24.dp),
            modifier = Modifier.weight(1f),
        ) {
            item {
                Button(onClick = ::countAllWithStock, modifier = Modifier.fillMaxWidth(), enabled = products.any { it.isStockTracked }) {
                    Icon(Icons.AutoMirrored.Filled.FactCheck, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Count everything with stock (${quantityByProduct.count { it.value > 0.0 }})")
                }
                Spacer(Modifier.height(StackGap))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it; miss = null },
                    label = { Text("Scan or type a barcode or SKU") },
                    placeholder = { Text("e.g. 6001000000011") },
                    singleLine = true,
                    trailingIcon = {
                        IconButton(onClick = ::addFromCode) { Icon(Icons.Filled.Add, contentDescription = "Add this code") }
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { addFromCode() }),
                    modifier = Modifier.fillMaxWidth(),
                )
                miss?.let { Hint(it, tone = Tone.Error) }
                matches.take(6).forEach { product ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { addProduct(product) },
                    ) {
                        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                            Text(product.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                "${product.sku} • book ${quantityByProduct[product.id]?.let { Units.formatQuantity(it) } ?: "—"} ${product.unit}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Pill("Count", Tone.Info)
                    }
                }
            }

            if (lines.isEmpty()) {
                item {
                    Spacer(Modifier.height(StackGap))
                    EmptyState(
                        title = "Nothing on the count sheet yet",
                        message = "Scan a barcode to add one product, or fill the sheet with everything this branch holds stock of. A cycle count is partial by design: count what was asked for, leave the rest alone.",
                        icon = Icons.AutoMirrored.Filled.FactCheck,
                    )
                }
            } else {
                item {
                    SectionTitle(
                        "Count sheet (${lines.size})",
                        caption = "${typed.size} counted · $varianceLines differ from the book · tap a line's number to change it",
                    )
                }
                items(lines, key = { it.product.id }) { line ->
                    CountLineCard(
                        line = line,
                        book = quantityByProduct[line.product.id],
                        packs = sheetPacks[line.product.id].orEmpty(),
                        problem = { candidate ->
                            val entered = candidate.counted.trim().toDoubleOrNull()
                            when {
                                entered == null -> "enter a number — 0 counts as \"none here\""
                                entered < 0.0 -> "a count cannot be below zero"
                                else -> (countedBase(candidate) as? Units.ConvertResult.Failed)
                                    ?.let { conversionProblem(it.code, candidate.unit, candidate.product.unit) }
                            }
                        },
                        baseOf = { candidate -> (countedBase(candidate) as? Units.ConvertResult.Ok)?.quantity },
                        onCountedChange = { text -> lines = lines.map { if (it.product.id == line.product.id) it.copy(counted = text) else it } },
                        onUnitChange = { unit -> lines = lines.map { if (it.product.id == line.product.id) it.copy(unit = unit) else it } },
                        onRemove = { lines = lines.filterNot { it.product.id == line.product.id } },
                    )
                }
            }

            item {
                if (invalid.isNotEmpty()) {
                    Banner(
                        message = "${invalid.size} line(s) cannot be counted yet — a count is a whole number for counted goods and never below zero.",
                        tone = Tone.Warning,
                    )
                    Spacer(Modifier.height(StackGap))
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("Why this count happened (optional)") },
                    placeholder = { Text("e.g. Sunday night count") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(StackGap))
                Button(
                    onClick = {
                        vm.queueStocktake(note = note, lines = drafts)
                        lines = emptyList()
                        note = ""
                    },
                    enabled = canQueue,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        if (drafts.isEmpty()) "Count at least one line"
                        else "Queue count (${drafts.size} line(s), $varianceLines differ)",
                    )
                }
                Hint("Queued offline if there is no signal. The server derives each variance against the book it holds and posts an adjustment movement per differing line, with you named as the actor.")
            }
        }
    }
}

/** One row of a count sheet: the product, the unit the field counts in, and what was read. */
private data class CountLine(
    val product: ProductEntity,
    /** The field as typed — blank means nobody counted this shelf yet. */
    val counted: String,
    /** The base unit, or one of the product's packs; the server converts it either way. */
    val unit: String,
)

/** One line of the sheet: what the book says, what was counted, and the variance in words. */
@Composable
private fun CountLineCard(
    line: CountLine,
    book: Double?,
    packs: List<ProductConversionEntity>,
    problem: (CountLine) -> String?,
    baseOf: (CountLine) -> Double?,
    onCountedChange: (String) -> Unit,
    onUnitChange: (String) -> Unit,
    onRemove: () -> Unit,
) {
    val product = line.product
    val entered = line.counted.trim().toDoubleOrNull()
    val isBase = line.unit.equals(product.unit, ignoreCase = true)
    val pack = packs.firstOrNull { it.unit.equals(line.unit, ignoreCase = true) }
    val options = remember(product.id, packs) { (listOf(product.unit) + packs.map { it.unit }).distinctBy { it.lowercase() } }
    val failure = problem(line)
    val counted = line.counted.isNotBlank()

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(product.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${product.sku} • " + (book?.let { "book ${Units.formatQuantity(it)} ${product.unit}" } ?: "book not cached"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = onRemove) {
                    Icon(Icons.Filled.Clear, contentDescription = "Remove ${product.name} from the count sheet")
                }
            }

            if (options.size > 1) {
                // Pills, the same way a direction is chosen on the transfers screen: the unit the
                // field below counts in. A crate is 24 bottles of soda and 12 of water, which is
                // why the pack hangs off the product and not off the unit (item 4.6).
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    options.forEach { option ->
                        Pill(
                            text = option,
                            tone = if (option.equals(line.unit, ignoreCase = true)) Tone.Info else Tone.Neutral,
                            modifier = Modifier.clickable { onUnitChange(option) },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = line.counted,
                onValueChange = onCountedChange,
                label = { Text("Counted (${line.unit})") },
                placeholder = { Text("what is on the shelf") },
                singleLine = true,
                isError = counted && (entered == null || entered < 0.0 || failure != null),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
            )

            val base = if (counted && failure == null) baseOf(line) else null
            when {
                failure != null -> Hint(failure, tone = Tone.Error)
                !counted -> Hint("Not counted yet — a blank line is left out of the count")
                entered != null && !isBase && pack != null && base != null -> Text(
                    "${Units.formatQuantity(entered)} ${line.unit} = ${Units.formatQuantity(base)} ${product.unit}",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            if (base != null && book != null) {
                val variance = base - book
                Text(
                    when {
                        Math.abs(variance) < VARIANCE_EPSILON -> "Agrees with the book — writes nothing"
                        variance < 0 -> "${Units.formatQuantity(-variance)} ${product.unit} short of the book"
                        else -> "${Units.formatQuantity(variance)} ${product.unit} found"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
