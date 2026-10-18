package com.kiosk.erp.feature.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.kiosk.erp.core.common.Pricing
import com.kiosk.erp.core.database.ProductEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A row in a simple dropdown picker (Material3's exposed dropdown menu is still experimental). */
private data class PickerOption(val label: String, val onClick: () -> Unit)

@Composable
fun CatalogScreen(vm: CatalogViewModel) {
    val products by vm.products.collectAsState()
    val query by vm.query.collectAsState()
    val meta by vm.meta.collectAsState()
    val editor by vm.editor.collectAsState()
    val importState by vm.importState.collectAsState()
    var managing by remember { mutableStateOf(false) }

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
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Catalogue", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(
            "${products.size} shown • ${meta.categories.size} categories • ${meta.taxCategories.size} tax rates",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            label = { Text("Search name, SKU or barcode") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onNew, modifier = Modifier.weight(1f)) { Text("New product") }
            OutlinedButton(onClick = onManage, modifier = Modifier.weight(1f)) { Text("Categories & tax") }
        }
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onRefresh) { Text("Refresh catalogue from server") }
            if (meta.message != null) {
                Text(meta.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismissMessage) { Text("Dismiss") }
            }
        }
        OutlinedButton(onClick = onImport) { Text("Import file (CSV or JSON)") }
        Text(
            "Loading a whole catalogue? Import a file: it is validated in full first, and a file with " +
                "any bad row writes nothing.",
            style = MaterialTheme.typography.bodySmall,
        )
        if (!meta.online) {
            Text(
                "Offline: the list below still works from the cache, but creating or editing a product needs a connection.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Spacer(Modifier.height(8.dp))
        if (products.isEmpty()) {
            Text(
                "No products cached yet. Refresh from the server, or create one.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(products, key = { it.id }) { product ->
                ProductRow(product = product, onEdit = { onEdit(product) }, onToggleActive = { onToggleActive(product, !product.isActive) })
            }
        }
    }
}

@Composable
private fun ProductRow(product: ProductEntity, onEdit: () -> Unit, onToggleActive: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(product.name, fontWeight = FontWeight.SemiBold)
                    if (!product.isActive) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "inactive",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
                Text(
                    "${product.sku} • ${Pricing.formatMinor(product.priceMinor)} KES • " +
                        "cost ${Pricing.formatMinor(product.costMinor)} • tax ${product.taxRateBp / 100.0}%" +
                        if (!product.isStockTracked) " • not stock-tracked" else "",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            TextButton(onClick = onEdit) { Text("Edit") }
            TextButton(onClick = onToggleActive) { Text(if (product.isActive) "Deactivate" else "Activate") }
        }
    }
}

// --- product editor ------------------------------------------------------------------------------

@Composable
private fun ProductEditorScreen(editor: ProductEditorState, meta: CatalogMeta, vm: CatalogViewModel) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = vm::closeEditor) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            Text(editor.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        Text(
            if (editor.isNew) "Creates the product on the server and caches it here."
            else "Saving replaces the stored values, including the barcode set.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(12.dp))

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
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                editor.priceText,
                { v -> vm.edit { it.copy(priceText = v) } },
                label = { Text("Selling price") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                isError = editor.priceText.isNotBlank() && editor.priceMinor == null,
                supportingText = {
                    Text(editor.priceMinor?.let { "= ${Pricing.formatMinor(it)} KES" } ?: "Up to two decimals, e.g. 65 or 65.50")
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
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(editor.unit, { v -> vm.edit { it.copy(unit = v) } }, label = { Text("Unit (ea, kg, l)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))

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
            Text(
                "No tax rates defined yet — add them under \"Categories & tax\" so sales charge the right VAT.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Spacer(Modifier.height(12.dp))

        SwitchRow("Tracks stock", "Off for services and fees that should not move stock.", editor.isStockTracked) { on ->
            vm.edit { it.copy(isStockTracked = on) }
        }
        SwitchRow("Active", "Inactive products stay on history but are hidden from the till.", editor.isActive) { on ->
            vm.edit { it.copy(isActive = on) }
        }
        Spacer(Modifier.height(12.dp))

        Text("Barcodes", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        Text("Scanned at the till straight from this device — no network needed.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(4.dp))
        editor.barcodes.forEach { code ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(code, modifier = Modifier.weight(1f))
                IconButton(onClick = { vm.removeBarcode(code) }) { Icon(Icons.Filled.Delete, contentDescription = "Remove $code") }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
            Spacer(Modifier.height(8.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = vm::save, enabled = editor.canSave, modifier = Modifier.weight(1f)) {
                Text(if (editor.saving) "Saving…" else "Save product")
            }
            OutlinedButton(onClick = vm::closeEditor, modifier = Modifier.weight(1f)) { Text("Cancel") }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun PickerField(label: String, selectedLabel: String?, options: List<PickerOption>) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Box {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
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
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = vm::cancelImport) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            Column(Modifier.weight(1f)) {
                Text("Import ${state.fileName}", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("Validated by the server — nothing has been written yet.", style = MaterialTheme.typography.bodySmall)
            }
        }
        Spacer(Modifier.height(8.dp))

        when {
            state.analysing -> Text("Checking the file…", style = MaterialTheme.typography.bodyMedium)
            state.error != null -> Text(state.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            report == null -> Text("No report yet.", style = MaterialTheme.typography.bodyMedium)
            else -> {
                Text(
                    "${report.rowCount} rows • ${report.validCount} ready • ${report.errorCount} problem(s)",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    "${report.createCount} new, ${report.updateCount} updated" +
                        if (report.categoriesToCreate.isEmpty()) "" else " • categories to create: ${report.categoriesToCreate.joinToString(", ")}",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (!report.isValid) {
                    Text(
                        "This file has problems, so committing it would write nothing. Fix the rows below " +
                            "and choose the file again.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (report.categoriesToCreate.isNotEmpty()) {
                    SwitchRow(
                        "Create the missing categories",
                        "Categories are labels; a missing tax rate is always an error.",
                        state.createMissingCategories,
                    ) { vm.setImportCreateMissingCategories(it) }
                }
                Spacer(Modifier.height(8.dp))

                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 16.dp), modifier = Modifier.weight(1f)) {
                    if (report.errors.isNotEmpty()) {
                        item { Text("Problems", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
                        items(report.errors, key = { "${it.line}:${it.code}:${it.field}" }) { error ->
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(12.dp)) {
                                    Text(
                                        "Line ${error.line}" + (error.sku?.let { " • $it" } ?: "") + (error.field?.let { " • $it" } ?: ""),
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(error.message, style = MaterialTheme.typography.bodySmall)
                                    Text(error.code, style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                    if (report.preview.isNotEmpty()) {
                        item { Text("Will be applied", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
                        items(report.preview, key = { it.line }) { row ->
                            Card(Modifier.fillMaxWidth()) {
                                Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Column(Modifier.weight(1f)) {
                                        Text("${row.sku} — ${row.name}", fontWeight = FontWeight.SemiBold)
                                        Text("line ${row.line} • ${row.unit}", style = MaterialTheme.typography.bodySmall)
                                    }
                                    Column {
                                        Text(Pricing.formatMinor(row.priceMinor), fontFamily = FontFamily.Monospace)
                                        Text(if (row.action == "create") "new" else "update", style = MaterialTheme.typography.labelSmall)
                                    }
                                }
                            }
                        }
                        if (report.previewTruncated) {
                            item { Text("…and more rows not shown.", style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = vm::commitImport,
                        enabled = report.isValid && !state.committing,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(
                            when {
                                state.committing -> "Importing…"
                                !report.isValid -> "Nothing to commit"
                                else -> "Commit ${report.createCount + report.updateCount} products"
                            },
                        )
                    }
                    OutlinedButton(onClick = vm::cancelImport, modifier = Modifier.weight(1f)) { Text("Cancel") }
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

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            Text("Categories & tax rates", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        meta.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(12.dp))

        Text("Categories", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (meta.categories.isEmpty()) Text("None yet.", style = MaterialTheme.typography.bodySmall)
        meta.categories.forEach { category -> Text("• ${category.name}", style = MaterialTheme.typography.bodyMedium) }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(newCategory, { newCategory = it }, label = { Text("New category") }, singleLine = true, modifier = Modifier.weight(1f))
            Button(onClick = { vm.createCategory(newCategory); newCategory = "" }, enabled = newCategory.isNotBlank()) { Text("Add") }
        }

        Spacer(Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(Modifier.height(16.dp))

        Text("Tax rates", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(
            "Rates are basis points behind the scenes, so 16% is exact — never 0.1600000000001.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(4.dp))
        if (meta.taxCategories.isEmpty()) Text("None yet.", style = MaterialTheme.typography.bodySmall)
        meta.taxCategories.forEach { tax ->
            Text(
                "• ${tax.name} — ${tax.rateBp / 100.0}%${if (tax.inclusive) ", price includes tax" else ", tax added at the till"}",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Spacer(Modifier.height(8.dp))
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
        ) { Text("Add tax rate") }
        Spacer(Modifier.height(24.dp))
    }
}
