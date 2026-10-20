package com.kiosk.erp.feature.catalog

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.common.Units
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.designsystem.Banner
import com.kiosk.erp.core.designsystem.EmptyState
import com.kiosk.erp.core.designsystem.Hint
import com.kiosk.erp.core.designsystem.LoadingState
import com.kiosk.erp.core.designsystem.Pill
import com.kiosk.erp.core.designsystem.ScreenHeader
import com.kiosk.erp.core.designsystem.ScreenPadding
import com.kiosk.erp.core.designsystem.SectionTitle
import com.kiosk.erp.core.designsystem.StackGap
import com.kiosk.erp.core.designsystem.Tone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A row in a simple dropdown picker (Material3's exposed dropdown menu is still experimental). */
private data class PickerOption(val label: String, val onClick: () -> Unit)

/** Which slice of the catalogue the list is showing. Stored by name so it survives rotation. */
private enum class ListFilter(val label: String) {
    All("All"),
    Active("Active"),
    Inactive("Inactive"),
}

@Composable
fun CatalogScreen(vm: CatalogViewModel) {
    val products by vm.products.collectAsState()
    val query by vm.query.collectAsState()
    val meta by vm.meta.collectAsState()
    val editor by vm.editor.collectAsState()
    val importState by vm.importState.collectAsState()
    var managing by rememberSaveable { mutableStateOf(false) }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            scope.launch {
                val text = withContext(Dispatchers.IO) {
                    runCatching { context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } }.getOrNull()
                }
                if (text == null) vm.importReadFailed() else vm.analyseImport(displayName(context, uri), text)
            }
        }
    }

    when {
        editor != null -> ProductEditorScreen(editor = editor!!, meta = meta, vm = vm)
        importState != null -> ImportPreviewScreen(state = importState!!, vm = vm)
        managing -> ManageCatalogueScreen(meta = meta, onBack = { managing = false }, vm = vm)
        else -> CatalogueListScreen(
            products = products,
            query = query,
            meta = meta,
            onQuery = vm::setQuery,
            onNew = vm::openNew,
            onEdit = vm::openForEdit,
            onToggleActive = vm::setActive,
            onRefresh = vm::refreshFromServer,
            onManage = { managing = true },
            onImport = { filePicker.launch(IMPORT_MIME_TYPES) },
            onDismissMessage = vm::clearMessage,
        )
    }
}

/** Most CSV files arrive as `text/csv`; JSON is accepted too, via the same column vocabulary. */
private val IMPORT_MIME_TYPES = arrayOf("text/*", "application/json", "application/vnd.ms-excel")

private fun displayName(context: Context, uri: Uri): String = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
}.getOrNull() ?: uri.lastPathSegment ?: "import"

// --- list ----------------------------------------------------------------------------------------

@Composable
private fun CatalogueListScreen(
    products: List<ProductEntity>,
    query: String,
    meta: CatalogMeta,
    onQuery: (String) -> Unit,
    onNew: () -> Unit,
    onEdit: (ProductEntity) -> Unit,
    onToggleActive: (ProductEntity, Boolean) -> Unit,
    onRefresh: () -> Unit,
    onManage: () -> Unit,
    onImport: () -> Unit,
    onDismissMessage: () -> Unit,
) {
    var filterName by rememberSaveable { mutableStateOf(ListFilter.All.name) }
    val filter = ListFilter.values().firstOrNull { it.name == filterName } ?: ListFilter.All
    val shown = remember(products, filter) {
        when (filter) {
            ListFilter.All -> products
            ListFilter.Active -> products.filter { it.isActive }
            ListFilter.Inactive -> products.filter { !it.isActive }
        }
    }

    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        ScreenHeader(
            title = "Catalogue",
            subtitle = "${products.size} product(s) cached · ${meta.categories.size} categories · ${meta.taxCategories.size} tax rates",
            actions = {
                IconButton(onClick = onRefresh) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh the catalogue from the server")
                }
            },
        )
        Spacer(Modifier.height(StackGap))

        if (!meta.online) {
            Banner(
                message = "Offline. The list below still works from the cache; creating or editing a product needs a connection.",
                tone = Tone.Warning,
                icon = Icons.Filled.CloudOff,
            )
            Spacer(Modifier.height(StackGap))
        }
        meta.message?.let { text ->
            Banner(
                message = text,
                tone = if (text.startsWith("Failed") || text.startsWith("Refresh failed") || text.startsWith("Could not")) Tone.Error else Tone.Success,
                onDismiss = onDismissMessage,
            )
            Spacer(Modifier.height(StackGap))
        }

        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            label = { Text("Search name, SKU or barcode") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { onQuery("") }) { Icon(Icons.Filled.Clear, contentDescription = "Clear search") }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(StackGap))

        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            ListFilter.values().forEach { option ->
                FilterChipButton(
                    label = option.label,
                    selected = option == filter,
                    onClick = { filterName = option.name },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        Spacer(Modifier.height(StackGap))

        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            Button(onClick = onNew, modifier = Modifier.weight(1f).heightIn(min = 46.dp)) { Text("New product") }
            OutlinedButton(onClick = onImport, modifier = Modifier.weight(1f).heightIn(min = 46.dp)) { Text("Import file") }
        }
        Spacer(Modifier.height(StackGap))
        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedButton(onClick = onManage, modifier = Modifier.weight(1f).heightIn(min = 46.dp)) {
                Icon(Icons.Filled.Category, contentDescription = null, modifier = Modifier.width(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Categories & tax")
            }
            OutlinedButton(onClick = onRefresh, modifier = Modifier.weight(1f).heightIn(min = 46.dp)) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.width(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Refresh")
            }
        }
        Spacer(Modifier.height(6.dp))
        Hint(
            "Bulk load? Import a CSV or JSON file — it is validated in full first, and a file with any bad row writes nothing.",
        )
        Spacer(Modifier.height(StackGap))

        when {
            products.isEmpty() -> EmptyState(
                title = "No products on this device yet",
                message = if (meta.online) "Refresh from the server to cache the catalogue, or create the first product."
                else "You are offline, so the catalogue cannot be filled in right now. It will appear here once a refresh succeeds.",
                icon = Icons.Filled.Inventory2,
                actionLabel = if (meta.online) "Refresh from server" else null,
                onAction = if (meta.online) onRefresh else null,
            )

            shown.isEmpty() -> EmptyState(
                title = "No ${filter.label.lowercase()} products match \"$query\"",
                message = "Try a different search, or switch the filter back to All.",
                icon = Icons.Filled.Search,
                actionLabel = "Show all",
                onAction = { onQuery(""); filterName = ListFilter.All.name },
            )

            else -> LazyColumn(
                verticalArrangement = Arrangement.spacedBy(StackGap),
                contentPadding = PaddingValues(bottom = 24.dp),
                modifier = Modifier.weight(1f),
            ) {
                items(shown, key = { it.id }) { product ->
                    ProductRow(product = product, onEdit = { onEdit(product) }, onToggleActive = { onToggleActive(product, !product.isActive) })
                }
            }
        }
    }
}

@Composable
private fun FilterChipButton(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    if (selected) {
        Button(onClick = onClick, modifier = modifier.heightIn(min = 40.dp)) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = 40.dp)) { Text(label) }
    }
}

@Composable
private fun ProductRow(product: ProductEntity, onEdit: () -> Unit, onToggleActive: () -> Unit) {
    var menuOpen by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onEdit).padding(start = 12.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        product.name,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (!product.isActive) {
                        Spacer(Modifier.width(8.dp))
                        Pill("Inactive", Tone.Error)
                    }
                }
                Text(
                    product.sku,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    (product.brandName?.let { "$it • " } ?: "") +
                        "cost ${Pricing.formatMinor(product.costMinor)} KES • tax ${product.taxRateBp / 100.0}%" +
                        if (!product.isStockTracked) " • not stock-tracked" else "",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "${Pricing.formatMinor(product.priceMinor)}",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Text("KES", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "More actions for ${product.name}")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Edit") },
                        onClick = { menuOpen = false; onEdit() },
                    )
                    DropdownMenuItem(
                        text = { Text(if (product.isActive) "Deactivate" else "Activate") },
                        onClick = { menuOpen = false; onToggleActive() },
                    )
                }
            }
        }
    }
}

// --- product editor ------------------------------------------------------------------------------

@Composable
private fun ProductEditorScreen(editor: ProductEditorState, meta: CatalogMeta, vm: CatalogViewModel) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding)) {
        ScreenHeader(
            title = editor.title,
            subtitle = if (editor.isNew) "Creates the product on the server and caches it here."
            else "Saving replaces the stored values, including the barcode set.",
            onBack = vm::closeEditor,
        )
        Spacer(Modifier.height(StackGap))

        SectionTitle("Identity")
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(editor.sku, { v -> vm.edit { it.copy(sku = v) } }, label = { Text("SKU") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(editor.name, { v -> vm.edit { it.copy(name = v) } }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            editor.description,
            { v -> vm.edit { it.copy(description = v) } },
            label = { Text("Description (optional)") },
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(StackGap))
        SectionTitle("Pricing", caption = "Amounts are exact — up to two decimals, never rounded for you.")
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedTextField(
                editor.priceText,
                { v -> vm.edit { it.copy(priceText = v) } },
                label = { Text("Selling price") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                isError = editor.priceText.isNotBlank() && editor.priceMinor == null,
                supportingText = {
                    Text(editor.priceMinor?.let { "= ${Pricing.formatMinor(it)} KES" } ?: "e.g. 65 or 65.50")
                },
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                editor.costText,
                { v -> vm.edit { it.copy(costText = v) } },
                label = { Text("Cost price") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                isError = editor.costText.isNotBlank() && editor.costMinor == null,
                supportingText = { Text("Blank = 0") },
                modifier = Modifier.weight(1f),
            )
        }

        Spacer(Modifier.height(StackGap))
        SectionTitle("Selling unit")
        Spacer(Modifier.height(6.dp))
        if (meta.units.isNotEmpty()) {
            // Picked from the shop's vocabulary rather than typed: `ea`, `kg` and `crate` have to be
            // the same words the server knows, or a receipt in them would be refused on arrival.
            PickerField(
                label = "Stock is held in",
                selectedLabel = meta.units.firstOrNull { it.code.equals(editor.unit, ignoreCase = true) }?.label ?: editor.unit,
                options = buildList {
                    meta.units.forEach { unit ->
                        add(PickerOption(unit.label) { vm.edit { it.copy(unit = unit.code) } })
                    }
                },
            )
        } else {
            OutlinedTextField(
                editor.unit,
                { v -> vm.edit { it.copy(unit = v) } },
                label = { Text("Unit (ea, kg, l)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            Hint("No unit list loaded — connect once and open Manage to pick units from the shop's list.", tone = Tone.Warning)
        }

        Spacer(Modifier.height(StackGap))
        SectionTitle(
            "Pack sizes",
            caption = "Bought by the crate, sold by the ${editor.unit}: a pack size only converts into the unit above — " +
                "stock itself is always held there.",
        )
        Spacer(Modifier.height(4.dp))
        if (editor.conversions.isEmpty()) {
            Text(
                "None yet, so receipts and adjustments can only be entered in ${editor.unit}.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        editor.conversions.forEach { conversion ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                Text(editor.conversionLabel(conversion), modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                IconButton(onClick = { vm.removeConversion(conversion.unit) }) {
                    Icon(Icons.Filled.Delete, contentDescription = "Remove the ${conversion.unit} pack size")
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedTextField(
                editor.newConversionUnit,
                { v -> vm.edit { it.copy(newConversionUnit = v) } },
                label = { Text("Pack unit, e.g. crate") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                editor.newConversionFactor,
                { v -> vm.edit { it.copy(newConversionFactor = v) } },
                label = { Text("= how many ${editor.unit}") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = vm::addConversion,
            enabled = editor.newConversionUnit.isNotBlank() && editor.newConversionFactor.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp),
        ) { Text("Add pack size") }

        Spacer(Modifier.height(StackGap))
        SectionTitle("Category, brand & tax")
        Spacer(Modifier.height(6.dp))
        PickerField(
            label = "Category",
            selectedLabel = meta.categories.firstOrNull { it.id == editor.categoryId }?.name,
            options = buildList {
                add(PickerOption("— none —") { vm.edit { it.copy(categoryId = null) } })
                meta.categories.forEach { category ->
                    add(PickerOption(category.name) { vm.edit { it.copy(categoryId = category.id) } })
                }
            },
        )
        Spacer(Modifier.height(8.dp))
        PickerField(
            label = "Brand",
            selectedLabel = meta.brands.firstOrNull { it.id == editor.brandId }?.name,
            options = buildList {
                add(PickerOption("— none —") { vm.edit { it.copy(brandId = null) } })
                meta.brands.forEach { brand ->
                    add(PickerOption(brand.name) { vm.edit { it.copy(brandId = brand.id) } })
                }
            },
        )
        if (meta.brands.isEmpty()) {
            Spacer(Modifier.height(4.dp))
            Hint("No brands yet — add them under Manage so imports and the list can name who makes this.")
        }
        Spacer(Modifier.height(8.dp))
        PickerField(
            label = "Tax rate",
            selectedLabel = meta.taxCategories.firstOrNull { it.id == editor.taxCategoryId }
                ?.let { "${it.name} (${it.rateBp / 100.0}%${if (it.inclusive) ", inclusive" else ""})" },
            options = buildList {
                add(PickerOption("— none (0%) —") { vm.edit { it.copy(taxCategoryId = null) } })
                meta.taxCategories.forEach { tax ->
                    add(PickerOption("${tax.name} (${tax.rateBp / 100.0}%)") { vm.edit { it.copy(taxCategoryId = tax.id) } })
                }
            },
        )
        if (meta.taxCategories.isEmpty()) {
            Spacer(Modifier.height(4.dp))
            Hint(
                "No tax rates defined yet — add them under \"Categories & tax\" so sales charge the right VAT.",
                tone = Tone.Error,
            )
        }

        Spacer(Modifier.height(StackGap))
        SectionTitle("Stock & status")
        Spacer(Modifier.height(6.dp))
        SwitchRow("Tracks stock", "Off for services and fees that should not move stock.", editor.isStockTracked) { on ->
            vm.edit { it.copy(isStockTracked = on) }
        }
        SwitchRow("Active", "Inactive products stay on history but are hidden from the till.", editor.isActive) { on ->
            vm.edit { it.copy(isActive = on) }
        }

        Spacer(Modifier.height(StackGap))
        SectionTitle("Barcodes", caption = "Scanned at the till straight from this device — no network needed.")
        Spacer(Modifier.height(4.dp))
        if (editor.barcodes.isEmpty()) {
            Text("No barcodes yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        editor.barcodes.forEach { code ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(code, modifier = Modifier.weight(1f), fontFamily = FontFamily.Monospace)
                IconButton(onClick = { vm.removeBarcode(code) }) { Icon(Icons.Filled.Delete, contentDescription = "Remove barcode $code") }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedTextField(
                editor.newBarcode,
                { v -> vm.edit { it.copy(newBarcode = v) } },
                label = { Text("Add barcode") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = vm::addBarcode, enabled = editor.newBarcode.isNotBlank()) { Text("Add") }
        }

        editor.error?.let {
            Spacer(Modifier.height(StackGap))
            Banner(message = it, tone = Tone.Error)
        }
        Spacer(Modifier.height(StackGap))
        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            Button(onClick = vm::save, enabled = editor.canSave, modifier = Modifier.weight(1.6f).heightIn(min = 50.dp)) {
                Text(if (editor.saving) "Saving…" else "Save product")
            }
            OutlinedButton(onClick = vm::closeEditor, modifier = Modifier.weight(1f).heightIn(min = 50.dp)) { Text("Cancel") }
        }
        if (!editor.canSave && !editor.saving) {
            Spacer(Modifier.height(6.dp))
            Hint("Enter a SKU, a name and a selling price to save.", tone = Tone.Neutral)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun PickerField(label: String, selectedLabel: String?, options: List<PickerOption>, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp)) {
                Text(selectedLabel ?: "— none —", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEach { option ->
                    DropdownMenuItem(text = { Text(option.label) }, onClick = { option.onClick(); expanded = false })
                }
            }
        }
    }
}

// --- bulk import (item 4.4) -----------------------------------------------------------------------

@Composable
private fun ImportPreviewScreen(state: ImportState, vm: CatalogViewModel) {
    val report = state.report
    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        ScreenHeader(
            title = "Import ${state.fileName}",
            subtitle = "Validated by the server — nothing has been written yet.",
            onBack = vm::cancelImport,
        )
        Spacer(Modifier.height(StackGap))

        when {
            state.analysing -> LoadingState("Checking every row of the file…")
            state.error != null -> Banner(message = state.error.orEmpty(), tone = Tone.Error, onDismiss = { vm.cancelImport() })
            report == null -> LoadingState("Waiting for a report…")
            else -> {
                Pill(
                    if (report.isValid) "Ready to commit" else "${report.errorCount} problem(s)",
                    if (report.isValid) Tone.Success else Tone.Error,
                )
                Spacer(Modifier.height(StackGap))
                Text(
                    "${report.rowCount} rows • ${report.validCount} ready • ${report.errorCount} problem(s)",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    buildString {
                        append("${report.createCount} new, ${report.updateCount} updated")
                        if (report.categoriesToCreate.isNotEmpty()) append(" • categories to create: ${report.categoriesToCreate.joinToString(", ")}")
                        if (report.brandsToCreate.isNotEmpty()) append(" • brands to create: ${report.brandsToCreate.joinToString(", ")}")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!report.isValid) {
                    Spacer(Modifier.height(6.dp))
                    Banner(
                        message = "This file has problems, so committing it would write nothing. Fix the rows below and choose the file again.",
                        tone = Tone.Error,
                    )
                }
                if (report.categoriesToCreate.isNotEmpty()) {
                    SwitchRow(
                        "Create the missing categories",
                        "Categories are labels; a missing tax rate is always an error.",
                        state.createMissingCategories,
                    ) { vm.setImportCreateMissingCategories(it) }
                }
                if (report.brandsToCreate.isNotEmpty()) {
                    SwitchRow(
                        "Create the missing brands",
                        "A brand the file names does not exist yet — create it, or fix the file to use one you already have.",
                        state.createMissingBrands,
                    ) { vm.setImportCreateMissingBrands(it) }
                }
                Spacer(Modifier.height(StackGap))

                LazyColumn(verticalArrangement = Arrangement.spacedBy(StackGap), contentPadding = PaddingValues(bottom = 16.dp), modifier = Modifier.weight(1f)) {
                    if (report.errors.isNotEmpty()) {
                        item { SectionTitle("Problems", caption = "Line numbers match your file.") }
                        items(report.errors, key = { "${it.line}:${it.code}:${it.field}" }) { error ->
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(12.dp)) {
                                    Text(
                                        "Line ${error.line}" + (error.sku?.let { " • $it" } ?: "") + (error.field?.let { " • $it" } ?: ""),
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(error.message, style = MaterialTheme.typography.bodySmall)
                                    Text(error.code, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                    if (report.preview.isNotEmpty()) {
                        item { SectionTitle("Will be applied") }
                        items(report.preview, key = { it.line }) { row ->
                            Card(Modifier.fillMaxWidth()) {
                                Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Column(Modifier.weight(1f)) {
                                        Text("${row.sku} — ${row.name}", fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        Text("line ${row.line} • ${row.unit}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    Column(horizontalAlignment = Alignment.End) {
                                        Text(Pricing.formatMinor(row.priceMinor), fontFamily = FontFamily.Monospace)
                                        Pill(if (row.action == "create") "new" else "update", if (row.action == "create") Tone.Info else Tone.Neutral)
                                    }
                                }
                            }
                        }
                        if (report.previewTruncated) {
                            item { Text("…and more rows not shown.", style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
                    Button(
                        onClick = vm::commitImport,
                        enabled = report.isValid && !state.committing,
                        modifier = Modifier.weight(1.6f).heightIn(min = 50.dp),
                    ) {
                        Text(
                            when {
                                state.committing -> "Importing…"
                                !report.isValid -> "Nothing to commit"
                                else -> "Commit ${report.createCount + report.updateCount} products"
                            },
                        )
                    }
                    OutlinedButton(onClick = vm::cancelImport, modifier = Modifier.weight(1f).heightIn(min = 50.dp)) { Text("Cancel") }
                }
            }
        }
    }
}

// --- categories & tax rates (item 4.3) -----------------------------------------------------------

@Composable
private fun ManageCatalogueScreen(meta: CatalogMeta, onBack: () -> Unit, vm: CatalogViewModel) {
    var newCategory by remember { mutableStateOf("") }
    var newTaxName by remember { mutableStateOf("") }
    var newTaxRate by remember { mutableStateOf("") }
    var newTaxInclusive by remember { mutableStateOf(true) }
    var newUnitCode by remember { mutableStateOf("") }
    var newUnitName by remember { mutableStateOf("") }
    var newUnitKind by remember { mutableStateOf(Units.KIND_COUNT) }
    var newBrand by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding)) {
        ScreenHeader(title = "Categories, tax, units & brands", onBack = onBack)
        meta.message?.let {
            Spacer(Modifier.height(StackGap))
            Banner(
                message = it,
                tone = if (it.startsWith("Failed")) Tone.Error else Tone.Success,
                onDismiss = vm::clearMessage,
            )
        }
        Spacer(Modifier.height(StackGap))

        SectionTitle("Categories", caption = "Labels for reporting and for import files.")
        Spacer(Modifier.height(6.dp))
        if (meta.categories.isEmpty()) {
            Text("None yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        meta.categories.forEach { category ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                Text(category.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            }
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedTextField(
                newCategory,
                { newCategory = it },
                label = { Text("New category") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { vm.createCategory(newCategory); newCategory = "" }, enabled = newCategory.isNotBlank()) { Text("Add") }
        }

        Spacer(Modifier.height(StackGap))
        HorizontalDivider()
        Spacer(Modifier.height(StackGap))

        SectionTitle("Tax rates", caption = "Stored in basis points, so 16% is exact — never 0.1600000000001.")
        Spacer(Modifier.height(6.dp))
        if (meta.taxCategories.isEmpty()) {
            Text("None yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        meta.taxCategories.forEach { tax ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(tax.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    Text(
                        "${tax.rateBp / 100.0}% • ${if (tax.inclusive) "price includes tax" else "tax added at the till"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Spacer(Modifier.height(StackGap))
        OutlinedTextField(newTaxName, { newTaxName = it }, label = { Text("Name, e.g. VAT 16%") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            newTaxRate,
            { newTaxRate = it },
            label = { Text("Rate %") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            supportingText = { Text("e.g. 16 or 16.5") },
            modifier = Modifier.fillMaxWidth(),
        )
        SwitchRow(
            "Prices include this tax",
            "Common in Kenyan retail: the shelf price already contains VAT.",
            newTaxInclusive,
        ) { newTaxInclusive = it }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                vm.createTaxCategory(newTaxName, newTaxRate, newTaxInclusive)
                newTaxName = ""
                newTaxRate = ""
            },
            enabled = newTaxName.isNotBlank() && newTaxRate.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
        ) { Text("Add tax rate") }
        Spacer(Modifier.height(6.dp))
        Hint(
            "A rate can only be added, not silently edited: changing what a shop charges mid-year is a " +
                "reporting question, so it needs the owner to decide what happens to prices already on the shelf.",
        )

        Spacer(Modifier.height(StackGap))
        HorizontalDivider()
        Spacer(Modifier.height(StackGap))

        SectionTitle("Units of measure", caption = "The words every quantity is written in — chosen here so a receipt in crates means the same thing everywhere.")
        Spacer(Modifier.height(6.dp))
        if (meta.units.isEmpty()) {
            Text("None yet — a product cannot take pack sizes until at least its own unit exists.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        meta.units.forEach { unit ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 3.dp)) {
                Text(unit.code, fontWeight = FontWeight.SemiBold, modifier = Modifier.width(72.dp))
                Column(Modifier.weight(1f)) {
                    Text(unit.name, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        if (unit.kind == Units.KIND_COUNT) "counted — quantities in it stay whole"
                        else "measured — quantities in it may be fractional",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Pill(unit.kind, if (unit.kind == Units.KIND_COUNT) Tone.Info else Tone.Neutral)
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedTextField(newUnitCode, { newUnitCode = it }, label = { Text("Code") }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(newUnitName, { newUnitName = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.weight(1.6f))
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            PickerField(
                label = "Kind",
                selectedLabel = newUnitKind,
                options = listOf(
                    PickerOption("count") { newUnitKind = Units.KIND_COUNT },
                    PickerOption("weight") { newUnitKind = Units.KIND_WEIGHT },
                    PickerOption("volume") { newUnitKind = Units.KIND_VOLUME },
                ),
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = {
                    vm.createUnit(newUnitCode, newUnitName.ifBlank { newUnitCode }, newUnitKind)
                    newUnitCode = ""
                    newUnitName = ""
                },
                enabled = newUnitCode.isNotBlank(),
                modifier = Modifier.heightIn(min = 46.dp).align(Alignment.Bottom),
            ) { Text("Add unit") }
        }

        Spacer(Modifier.height(StackGap))
        HorizontalDivider()
        Spacer(Modifier.height(StackGap))

        SectionTitle("Brands", caption = "Who makes a product. One name, whatever the capital letters — an import file matches on it.")
        Spacer(Modifier.height(6.dp))
        if (meta.brands.isEmpty()) {
            Text("None yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        meta.brands.forEach { brand ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 3.dp)) {
                Text(brand.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            }
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(StackGap)) {
            OutlinedTextField(
                newBrand,
                { newBrand = it },
                label = { Text("New brand") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { vm.createBrand(newBrand); newBrand = "" }, enabled = newBrand.isNotBlank()) { Text("Add") }
        }
        Spacer(Modifier.height(24.dp))
    }
}
