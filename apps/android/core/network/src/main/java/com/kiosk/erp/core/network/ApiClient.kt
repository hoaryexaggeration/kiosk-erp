package com.kiosk.erp.core.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class ApiException(val statusCode: Int, val code: String, message: String) : Exception(message)

data class PushResult(
    val commandId: String,
    val status: String,
    val code: String?,
    val message: String?,
    val result: JsonObject?,
)

data class PullPage(val events: List<JsonObject>, val cursor: Long, val hasMore: Boolean)

/** Typed result of an authentication call, so feature modules never touch raw JSON. */
data class AuthSession(
    val accessToken: String,
    val refreshToken: String?,
    val tenantId: String?,
    val userId: String?,
)

/**
 * A pack size (item 4.6): `1 <unit> = <factor> <product's base unit>`. Stock is only ever held in
 * the base unit, so `factor` is what turns a receipt in crates into bottles on one ledger.
 */
data class ServerConversion(val unit: String, val factor: Double)

data class ServerProduct(
    val id: String,
    val sku: String,
    val name: String,
    val unit: String,
    val priceMinor: Long,
    val costMinor: Long,
    val version: Int,
    val taxRateBp: Int,
    val taxInclusive: Boolean,
    val barcodes: List<String> = emptyList(),
    val description: String? = null,
    val categoryId: String? = null,
    val taxCategoryId: String? = null,
    val brandId: String? = null,
    val brandName: String? = null,
    /**
     * `count` / `weight` / `volume` for the unit this product is stocked in, or null when that unit
     * is not in the shop's vocabulary. Carried with the conversions because the two travel together:
     * a pack conversion needs the rule its base unit implies, offline (item 4.6).
     */
    val unitKind: String? = null,
    /** Low-stock threshold in base units (item 4.9); null = nobody is watching this line. */
    val reorderPoint: Double? = null,
    /**
     * The version of the BASE price (item 4.11). It moves only when the price amount does, so a
     * till snapshot can say WHICH price it charged without a description edit invalidating it.
     */
    val priceVersion: Int = 1,
    /** Price lists in force for this product (item 4.11) — the device prices itself offline. */
    val priceOverrides: List<ServerPriceOverride> = emptyList(),
    /** The full set the server reports for this product — replaced into the cache as a SET. */
    val conversions: List<ServerConversion> = emptyList(),
    val isStockTracked: Boolean = true,
    val isActive: Boolean = true,
)

data class ServerCategory(val id: String, val name: String, val parentId: String? = null)

/**
 * One price-list row as the server reports it (item 4.11): dated and optionally branch-scoped. A
 * till keeps these with the product so the shelf prices itself offline — a scheduled flip takes
 * over the moment its window opens, with no push required.
 */
data class ServerPriceOverride(
    val id: String,
    /** Null = the tenant-wide list (every branch); otherwise exactly this shelf. */
    val branchId: String? = null,
    val branchName: String? = null,
    val priceMinor: Long,
    /** Epoch millis (the wire format is ISO-8601). */
    val validFromEpochMs: Long,
    /** Exclusive window end; null = open-ended ("until I say otherwise"). */
    val validToEpochMs: Long? = null,
)

/** One entry of the price-change history (item 4.11): old → new, who, when, and via what path. */
data class ServerPriceHistoryEntry(
    val id: String,
    val branchName: String? = null,
    val oldPriceMinor: Long?,
    val newPriceMinor: Long,
    val source: String,
    val actorName: String? = null,
    val changedAtEpochMs: Long,
)

data class ServerTaxCategory(val id: String, val name: String, val rateBp: Int, val inclusive: Boolean)

/** A unit of measure (item 4.6). `kind` decides whether a converted quantity must stay whole. */
data class ServerUnit(val code: String, val name: String, val kind: String) {
    /** What the operator reads: `crate (count)`. */
    val label: String get() = "$code ($kind)"
}

/** A brand a product can belong to (§3.C). Names are unique per shop, ignoring case. */
data class ServerBrand(val id: String, val name: String)

/**
 * Everything the catalogue editor can set. `barcodes` and `conversions` are the FULL desired sets —
 * the server replaces what it holds (items 4.1 and 4.6), so removing a tag or a pack size here
 * removes it everywhere after sync. `expectedVersion` carries the optimistic-concurrency check so a
 * stale edit cannot silently win.
 */
data class ProductDraft(
    val id: String?,
    val sku: String,
    val name: String,
    val description: String? = null,
    val categoryId: String? = null,
    val taxCategoryId: String? = null,
    val brandId: String? = null,
    val unit: String = "ea",
    val priceMinor: Long = 0,
    val costMinor: Long = 0,
    /** Low-stock threshold in base units, or null for "no alert configured" (item 4.9). */
    val reorderPoint: Double? = null,
    val isStockTracked: Boolean = true,
    val isActive: Boolean = true,
    val barcodes: List<String> = emptyList(),
    val conversions: List<ServerConversion> = emptyList(),
    val expectedVersion: Int? = null,
)

data class ServerBalance(
    val productId: String,
    val branchId: String,
    val sku: String,
    val name: String,
    val quantity: Double,
)

/**
 * One immutable stock movement as the server records it. `quantityDelta` is signed, `reason` is the
 * operator's words, and `sourceType` says what produced it (opening_stock, stock_receipt,
 * stock_adjustment, sale) so history can be read without guessing. `cogsMinor` is only set on issues
 * (ADR 0009).
 */
data class ServerMovement(
    val id: String,
    val productId: String,
    val sku: String,
    /** The BASE-unit quantity the ledger holds — the only number stock is ever counted in. */
    val quantityDelta: Double,
    val unit: String,
    /** The pack the paperwork said, when it was a different unit: "10 crate" for +240 ea (item 4.6). */
    val enteredUnit: String?,
    val enteredQuantity: Double?,
    val reason: String?,
    val sourceType: String,
    val sourceId: String?,
    val cogsMinor: Long?,
    /** Who the server holds as having done it — a movement must be attributable (§15, item 4.8). */
    val actorId: String?,
    val actorName: String?,
    val occurredAt: String,
) {
    /** True when the movement arrived in a pack rather than the unit stock is held in. */
    val wasConverted: Boolean get() = enteredUnit != null && enteredQuantity != null
}

/**
 * A branch of this tenant (item 4.7) as `GET /v1/config/snapshot` reports it. The device caches
 * these so the destination picker works with the network down — a transfer is a decision made at
 * the shelf, and the shelf does not wait for a connection.
 */
data class ServerBranch(val id: String, val code: String, val name: String)

/**
 * One line of a cross-branch transfer (item 4.7) in the words the document was written in:
 * `dispatched` is what left the source branch in base units, `enteredQuantity`/`enteredUnit` is how
 * it was written on the paperwork, `received` is what the destination counted (null until it did),
 * and `unitCostMinor` is the cost that travelled with the goods.
 */
data class ServerTransferLine(
    val productId: String,
    val sku: String,
    val name: String,
    val unit: String,
    val enteredUnit: String?,
    val enteredQuantity: Double?,
    val dispatched: Double,
    val received: Double?,
    val unitCostMinor: Long,
    val shortage: Double,
)

/**
 * A cross-branch transfer document (item 4.7, ADR 0008): one document with two per-branch halves.
 * The server only ever reports documents THIS branch is party to — what it sent and is waiting on,
 * and what is coming to it.
 */
data class ServerTransfer(
    val id: String,
    val reference: String,
    val fromBranchId: String,
    val toBranchId: String,
    val fromBranchName: String,
    val toBranchName: String,
    /** `dispatched` (waiting at the destination) | `received` | `discrepancy` (arrived short). */
    val status: String,
    val note: String?,
    val approvalNote: String?,
    val dispatchedAt: String,
    val receivedAt: String?,
    val lineCount: Int,
    /** Units physically out on this document right now — 0 once it has arrived. */
    val inTransitQuantity: Double,
    val shortageQuantity: Double,
    val lines: List<ServerTransferLine>,
)

/** One rejected row of a bulk import, pointing at the line the operator sees in their file. */
data class ImportRowError(
    val line: Int,
    val sku: String?,
    val field: String?,
    val code: String,
    val message: String,
)

data class ImportPreviewRow(
    val line: Int,
    val action: String,
    val sku: String,
    val name: String,
    val priceMinor: Long,
    val unit: String,
)

/**
 * The result of a bulk import. A file with errors answers with this report rather than an error
 * status: a preview that found problems is a successful preview, not a failed request. `invalid`
 * means nothing was written.
 */
data class ImportReport(
    val status: String,
    val rowCount: Int,
    val validCount: Int,
    val errorCount: Int,
    val createCount: Int,
    val updateCount: Int,
    val categoriesToCreate: List<String> = emptyList(),
    /** Brands the file names that do not exist yet — created only if the operator asks (item 4.6). */
    val brandsToCreate: List<String> = emptyList(),
    val errors: List<ImportRowError> = emptyList(),
    val preview: List<ImportPreviewRow> = emptyList(),
    val previewTruncated: Boolean = false,
) {
    val isValid: Boolean get() = errorCount == 0
}

/**
 * One advisory from the opening-stock planner. A warning never blocks an import — the operator
 * decides — but it is always shown before the commit is offered, because it is telling them
 * something they cannot see from the file alone (existing opening stock, a branch that has traded).
 */
data class OpeningStockWarning(
    val line: Int,
    val sku: String?,
    val field: String?,
    val code: String,
    val message: String,
)

/** One planned line: what is on hand now, what this line adds, and what it will be worth. */
data class OpeningStockPreviewRow(
    val line: Int,
    val sku: String,
    val name: String,
    /** The unit the quantity will be RECORDED in: always the product's base unit (item 4.6). */
    val unit: String,
    val quantity: Double,
    /** What the file said when it named a pack (`crate`) instead — null for a plain base-unit row. */
    val enteredUnit: String?,
    val enteredQuantity: Double?,
    val onHandBefore: Double,
    val onHandAfter: Double,
    val unitCostMinor: Long,
    val valueMinor: Long,
    val costWasGiven: Boolean,
)

/**
 * The result of an opening-stock import. `invalid` means nothing was written; `alreadyApplied`
 * means a retried commit found its own movements and left them alone, so the operator is not told
 * twice that a fresh import succeeded.
 */
data class OpeningStockReport(
    val status: String,
    val alreadyApplied: Boolean,
    val rowCount: Int,
    val validCount: Int,
    val errorCount: Int,
    val warningCount: Int,
    val totalQuantity: Double,
    val totalValueMinor: Long,
    val errors: List<ImportRowError> = emptyList(),
    val warnings: List<OpeningStockWarning> = emptyList(),
    val preview: List<OpeningStockPreviewRow> = emptyList(),
    val previewTruncated: Boolean = false,
) {
    val isValid: Boolean get() = errorCount == 0 && validCount > 0
}

/**
 * The file an operator picked, kept as text. CSV and JSON use the same column vocabulary on the
 * server, so the only difference here is how the bytes are framed — never re-serialised, so what the
 * server validates in a preview is exactly what a commit sends.
 */
sealed interface ImportSource {
    val text: String

    data class Csv(override val text: String) : ImportSource
    data class Json(override val text: String) : ImportSource

    companion object {
        /** A `.json` name or a JSON-looking first character; everything else is treated as CSV. */
        fun detect(fileName: String, text: String): ImportSource {
            val head = text.trimStart().firstOrNull()
            val looksJson = fileName.trim().lowercase().endsWith(".json") || head == '[' || head == '{'
            return if (looksJson) Json(text) else Csv(text)
        }
    }
}

/**
 * Thin REST client for the sync/control plane. Reads are always satisfied from the local
 * database first; this client only pushes commands and pulls deltas (§5).
 */
class ApiClient {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun url(baseUrl: String, path: String): String = baseUrl.trimEnd('/') + "/" + path.trimStart('/')

    private fun post(baseUrl: String, path: String, token: String?, body: JsonElement): JsonElement {
        val builder = Request.Builder().url(url(baseUrl, path)).post(body.toString().toRequestBody(jsonMedia))
        if (token != null) builder.header("authorization", "Bearer $token")
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                throw parseError(response.code, text)
            }
            return if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text)
        }
    }

    private fun patch(baseUrl: String, path: String, token: String?, body: JsonElement): JsonElement {
        val builder = Request.Builder().url(url(baseUrl, path)).patch(body.toString().toRequestBody(jsonMedia))
        if (token != null) builder.header("authorization", "Bearer $token")
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                throw parseError(response.code, text)
            }
            return if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text)
        }
    }

    private fun get(baseUrl: String, path: String, token: String?): JsonElement {        val builder = Request.Builder().url(url(baseUrl, path)).get()
        if (token != null) builder.header("authorization", "Bearer $token")
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string() ?: ""
            if (!response.isSuccessful) throw parseError(response.code, text)
            return if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text)
        }
    }

    private fun delete(baseUrl: String, path: String, token: String?): JsonElement {
        val builder = Request.Builder().url(url(baseUrl, path)).delete()
        if (token != null) builder.header("authorization", "Bearer $token")
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string() ?: ""
            if (!response.isSuccessful) throw parseError(response.code, text)
            return if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text)
        }
    }

    private fun parseError(status: Int, text: String): ApiException {
        val code = runCatching { json.parseToJsonElement(text).jsonObject["code"]?.jsonPrimitive?.content }.getOrNull() ?: "HTTP_$status"
        val message = runCatching { json.parseToJsonElement(text).jsonObject["message"]?.jsonPrimitive?.content }.getOrNull() ?: text
        return ApiException(status, code, message)
    }

    suspend fun login(baseUrl: String, email: String, password: String, deviceId: String?): AuthSession = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("email", email)
            put("password", password)
            if (deviceId != null) put("deviceId", deviceId)
        }
        val obj = post(baseUrl, "auth/login", null, body).jsonObject
        val user = obj["user"] as? JsonObject
        AuthSession(
            accessToken = obj["accessToken"]?.jsonPrimitive?.content ?: error("Login response had no access token"),
            refreshToken = obj["refreshToken"]?.jsonPrimitive?.content,
            tenantId = user?.get("tenantId")?.jsonPrimitive?.content,
            userId = user?.get("id")?.jsonPrimitive?.content,
        )
    }

    suspend fun enrollDevice(baseUrl: String, token: String, deviceId: String, branchId: String, name: String, appVersion: String) {
        withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                put("deviceId", deviceId)
                put("branchId", branchId)
                put("name", name)
                put("platform", "android")
                put("isOfflineAuthoritative", true)
                put("appVersion", appVersion)
            }
            post(baseUrl, "devices/enroll", token, body)
        }
    }

    suspend fun push(baseUrl: String, token: String, commands: List<JsonObject>): List<PushResult> = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("commands", JsonArray(commands)) }
        val response = post(baseUrl, "sync/push", token, body).jsonObject
        response["results"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            PushResult(
                commandId = obj["commandId"]?.jsonPrimitive?.content ?: "",
                status = obj["status"]?.jsonPrimitive?.content ?: "retryable",
                code = obj["code"]?.jsonPrimitive?.content,
                message = obj["message"]?.jsonPrimitive?.content,
                result = obj["result"]?.let { if (it is JsonObject) it else null },
            )
        } ?: emptyList()
    }

    suspend fun pull(baseUrl: String, token: String, cursor: Long, limit: Int = 200): PullPage = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "sync/pull?cursor=$cursor&limit=$limit", token).jsonObject
        val events = response["events"]?.jsonArray?.map { it.jsonObject } ?: emptyList()
        PullPage(events = events, cursor = response["cursor"]?.jsonPrimitive?.content?.toLongOrNull() ?: cursor, hasMore = false)
    }

    /**
     * The whole catalogue, walked page by page.
     *
     * One request capped at the server's 500-row maximum silently truncated anything beyond it, so a
     * shop's first 500 SKUs were the only ones a till could ever scan. The loop stops on a short page
     * (the server's contract for "no more rows") and on an explicit ceiling, so a pathological
     * response can never spin.
     */
    suspend fun serverProducts(baseUrl: String, token: String): List<ServerProduct> = withContext(Dispatchers.IO) {
        val pageSize = 500
        val all = mutableListOf<ServerProduct>()
        var offset = 0
        while (offset < 20_000) {
            val response = get(baseUrl, "products?limit=$pageSize&offset=$offset", token).jsonObject
            val page = response["products"]?.jsonArray?.map { it.jsonObject.toServerProduct() } ?: emptyList()
            all += page
            if (page.size < pageSize) break
            offset += pageSize
        }
        all
    }

    /**
     * Create or update a catalogue product.
     *
     * Editing the catalogue is a server-authoritative management action, not a cashier-loop write, so
     * it talks to the server directly and does NOT go through the offline outbox: a product with two
     * conflicting offline versions has no meaningful field-level merge, and inventing one would risk
     * the exact "last write wins on money" failure §7 forbids. The UI states plainly that it needs a
     * connection. Reads stay offline from Room.
     */
    suspend fun saveProduct(baseUrl: String, token: String, draft: ProductDraft): ServerProduct = withContext(Dispatchers.IO) {
        val creating = draft.id == null
        val path = if (creating) "products" else "products/${draft.id}"
        val body = productBody(draft, forCreate = creating)
        val response = if (creating) post(baseUrl, path, token, body) else patch(baseUrl, path, token, body)
        response.jsonObject.toServerProduct()
    }

    /** An ISO-8601 instant from the server → epoch millis; garbage becomes null, never a guess. */
    private fun parseInstantEpochMs(iso: String): Long? = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()

    /** One product's price lists (item 4.11), newest window first. */
    suspend fun priceOverrides(baseUrl: String, token: String, productId: String): List<ServerPriceOverride> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "pricing/overrides?productId=$productId", token).jsonObject
        response["overrides"]?.jsonArray?.mapNotNull { element ->
            val row = element.jsonObject
            val id = row["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val price = row["price_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@mapNotNull null
            val from = row["valid_from"]?.jsonPrimitive?.contentOrNull?.let(::parseInstantEpochMs) ?: return@mapNotNull null
            ServerPriceOverride(
                id = id,
                branchId = row["branch_id"]?.jsonPrimitive?.contentOrNull,
                branchName = row["branch_name"]?.jsonPrimitive?.contentOrNull,
                priceMinor = price,
                validFromEpochMs = from,
                validToEpochMs = row["valid_to"]?.jsonPrimitive?.contentOrNull?.let(::parseInstantEpochMs),
            )
        } ?: emptyList()
    }

    /**
     * Create or replace a price-list row (item 4.11). `validFrom`/`validTo` travel as ISO-8601
     * instants, exactly as the server stores windows; an open end is an explicit JSON null.
     */
    suspend fun savePriceOverride(
        baseUrl: String,
        token: String,
        overrideId: String?,
        productId: String,
        branchId: String?,
        priceMinor: Long,
        validFromIso: String,
        validToIso: String?,
    ): String = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            if (overrideId == null) put("productId", productId)
            put("branchId", branchId)
            put("priceMinor", priceMinor)
            put("validFrom", validFromIso)
            put("validTo", validToIso)
        }
        if (overrideId == null) {
            post(baseUrl, "pricing/overrides", token, body).jsonObject["id"]?.jsonPrimitive?.content ?: ""
        } else {
            patch(baseUrl, "pricing/overrides/$overrideId", token, body)
            overrideId
        }
    }

    suspend fun deletePriceOverride(baseUrl: String, token: String, overrideId: String): Unit = withContext(Dispatchers.IO) {
        delete(baseUrl, "pricing/overrides/$overrideId", token)
        Unit
    }

    /** Price-change history (item 4.11), newest first — who moved which price, and via what. */
    suspend fun priceHistory(baseUrl: String, token: String, productId: String): List<ServerPriceHistoryEntry> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "pricing/history?productId=$productId", token).jsonObject
        response["history"]?.jsonArray?.mapNotNull { element ->
            val row = element.jsonObject
            val id = row["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val newPrice = row["newPriceMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@mapNotNull null
            val changedAt = row["changedAt"]?.jsonPrimitive?.contentOrNull?.let(::parseInstantEpochMs) ?: return@mapNotNull null
            ServerPriceHistoryEntry(
                id = id,
                branchName = row["branchName"]?.jsonPrimitive?.contentOrNull,
                oldPriceMinor = row["oldPriceMinor"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
                newPriceMinor = newPrice,
                source = row["source"]?.jsonPrimitive?.contentOrNull ?: "",
                actorName = row["actorName"]?.jsonPrimitive?.contentOrNull,
                changedAtEpochMs = changedAt,
            )
        } ?: emptyList()
    }

    suspend fun categories(baseUrl: String, token: String): List<ServerCategory> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "categories", token).jsonObject
        response["categories"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerCategory(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
                parentId = obj["parent_id"]?.jsonPrimitive?.contentOrNull,
            )
        } ?: emptyList()
    }

    suspend fun createCategory(baseUrl: String, token: String, name: String): ServerCategory = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("name", name) }
        val obj = post(baseUrl, "categories", token, body).jsonObject
        ServerCategory(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            name = obj["name"]?.jsonPrimitive?.content ?: name,
            parentId = obj["parent_id"]?.jsonPrimitive?.contentOrNull,
        )
    }

    suspend fun taxCategories(baseUrl: String, token: String): List<ServerTaxCategory> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "tax-categories", token).jsonObject
        response["taxCategories"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerTaxCategory(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
                rateBp = obj["rate_bp"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                inclusive = obj["inclusive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
            )
        } ?: emptyList()
    }

    suspend fun createTaxCategory(baseUrl: String, token: String, name: String, rateBp: Int, inclusive: Boolean): ServerTaxCategory = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("name", name)
            put("rateBp", rateBp)
            put("inclusive", inclusive)
        }
        val obj = post(baseUrl, "tax-categories", token, body).jsonObject
        ServerTaxCategory(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            name = obj["name"]?.jsonPrimitive?.content ?: name,
            rateBp = obj["rate_bp"]?.jsonPrimitive?.content?.toIntOrNull() ?: rateBp,
            inclusive = obj["inclusive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: inclusive,
        )
    }

    /**
     * The unit vocabulary (item 4.6). Every quantity the device shows or queues is expressed in one
     * of these, and `kind` is what says a counted base must stay whole — so this is read before an
     * adjustment in packs can be offered at all.
     */
    suspend fun units(baseUrl: String, token: String): List<ServerUnit> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "units", token).jsonObject
        response["units"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerUnit(
                code = obj["code"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
                kind = obj["kind"]?.jsonPrimitive?.content ?: "count",
            )
        } ?: emptyList()
    }

    suspend fun createUnit(baseUrl: String, token: String, code: String, name: String, kind: String): ServerUnit = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("code", code)
            put("name", name)
            put("kind", kind)
        }
        val obj = post(baseUrl, "units", token, body).jsonObject
        ServerUnit(
            code = obj["code"]?.jsonPrimitive?.content ?: code,
            name = obj["name"]?.jsonPrimitive?.content ?: name,
            kind = obj["kind"]?.jsonPrimitive?.content ?: kind,
        )
    }

    suspend fun brands(baseUrl: String, token: String): List<ServerBrand> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "brands", token).jsonObject
        response["brands"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerBrand(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList()
    }

    suspend fun createBrand(baseUrl: String, token: String, name: String): ServerBrand = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("name", name) }
        val obj = post(baseUrl, "brands", token, body).jsonObject
        ServerBrand(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            name = obj["name"]?.jsonPrimitive?.content ?: name,
        )
    }

    /**
     * `POST /products` rejects an explicit null for description/category/tax (only `undefined` is
     * accepted), so a create omits absent optionals while an update sends null to clear them.
     * `brandId` follows that rule exactly, and both sets (`barcodes`, `conversions`) are always
     * sent: what the editor holds is what the product should have (items 4.1 and 4.6).
     */
    private fun productBody(draft: ProductDraft, forCreate: Boolean): JsonObject = buildJsonObject {
        put("sku", draft.sku)
        put("name", draft.name)
        put("unit", draft.unit)
        put("priceMinor", draft.priceMinor)
        put("costMinor", draft.costMinor)
        // Sent on create AND update because the two meanings meet here: null is "no threshold" on
        // a new product and "clear it" on an edit — clearing must be a value, never an absence.
        put("reorderPoint", draft.reorderPoint)
        put("isStockTracked", draft.isStockTracked)
        put("barcodes", JsonArray(draft.barcodes.map { JsonPrimitive(it) }))
        put(
            "conversions",
            JsonArray(draft.conversions.map { conversion ->
                buildJsonObject {
                    put("unit", conversion.unit)
                    put("factor", conversion.factor)
                }
            }),
        )
        if (forCreate) {
            draft.description?.let { put("description", it) }
            draft.categoryId?.let { put("categoryId", it) }
            draft.taxCategoryId?.let { put("taxCategoryId", it) }
            draft.brandId?.let { put("brandId", it) }
        } else {
            put("description", draft.description)
            put("categoryId", draft.categoryId)
            put("taxCategoryId", draft.taxCategoryId)
            put("brandId", draft.brandId)
            put("isActive", draft.isActive)
            draft.expectedVersion?.let { put("expectedVersion", it) }
        }
    }

    private fun JsonObject.toServerProduct(): ServerProduct = ServerProduct(
        id = this["id"]?.jsonPrimitive?.content ?: "",
        sku = this["sku"]?.jsonPrimitive?.content ?: "",
        name = this["name"]?.jsonPrimitive?.content ?: "",
        unit = this["unit"]?.jsonPrimitive?.content ?: "ea",
        priceMinor = this["price_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
        costMinor = this["cost_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
        version = this["version"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1,
        taxRateBp = this["tax_rate_bp"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        taxInclusive = this["tax_inclusive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
        barcodes = this["barcodes"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
        description = this["description"]?.jsonPrimitive?.contentOrNull,
        categoryId = this["category_id"]?.jsonPrimitive?.contentOrNull,
        taxCategoryId = this["tax_category_id"]?.jsonPrimitive?.contentOrNull,
        brandId = this["brand_id"]?.jsonPrimitive?.contentOrNull,
        brandName = this["brand_name"]?.jsonPrimitive?.contentOrNull,
        unitKind = this["unit_kind"]?.jsonPrimitive?.contentOrNull,
        // JSON null and a missing key both mean "no threshold" — contentOrNull swallows JsonNull.
        reorderPoint = this["reorder_point"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull(),
        priceVersion = this["price_version"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1,
        priceOverrides = this["price_overrides"]?.jsonArray?.mapNotNull { element ->
            val row = element.jsonObject
            val id = row["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val price = row["price_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@mapNotNull null
            val from = row["valid_from"]?.jsonPrimitive?.contentOrNull?.let(::parseInstantEpochMs) ?: return@mapNotNull null
            ServerPriceOverride(
                id = id,
                branchId = row["branch_id"]?.jsonPrimitive?.contentOrNull,
                branchName = row["branch_name"]?.jsonPrimitive?.contentOrNull,
                priceMinor = price,
                validFromEpochMs = from,
                validToEpochMs = row["valid_to"]?.jsonPrimitive?.contentOrNull?.let(::parseInstantEpochMs),
            )
        } ?: emptyList(),
        conversions = this["conversions"]?.jsonArray?.mapNotNull { element ->
            val conversion = element.jsonObject
            val unit = conversion["unit"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val factor = conversion["factor"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: return@mapNotNull null
            ServerConversion(unit = unit, factor = factor)
        } ?: emptyList(),
        isStockTracked = this["is_stock_tracked"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
        isActive = this["is_active"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
    )

    /**
     * Stock balances. With a branch stated, the response is that branch's shelf and nothing else
     * (item 4.7): leaving it off merges every branch of the tenant into one projection, so two
     * branches holding the same product would collapse into a single arbitrary number — the till
     * must read the shelf it stands in front of (ADR 0008 item 5).
     */
    suspend fun inventoryBalances(baseUrl: String, token: String, branchId: String? = null): List<ServerBalance> = withContext(Dispatchers.IO) {
        val query = if (branchId.isNullOrBlank()) "inventory/balances?limit=500" else "inventory/balances?limit=500&branchId=$branchId"
        val response = get(baseUrl, query, token).jsonObject
        response["balances"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerBalance(
                productId = obj["product_id"]?.jsonPrimitive?.content ?: "",
                branchId = obj["branch_id"]?.jsonPrimitive?.content ?: "",
                sku = obj["sku"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
                quantity = obj["quantity"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
            )
        } ?: emptyList()
    }

    /**
     * Cross-branch transfers this branch is party to (item 4.7). The device must state which branch
     * it is asking about, and the server checks that against this device's enrolment — a till reads
     * its own branch's movements and nothing else (ADR 0008 item 5).
     */
    suspend fun inventoryTransfers(baseUrl: String, token: String, branchId: String): List<ServerTransfer> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "inventory/transfers?branchId=$branchId&limit=500", token).jsonObject
        response["transfers"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerTransfer(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                reference = obj["reference"]?.jsonPrimitive?.content ?: "",
                fromBranchId = obj["fromBranchId"]?.jsonPrimitive?.content ?: "",
                toBranchId = obj["toBranchId"]?.jsonPrimitive?.content ?: "",
                fromBranchName = obj["fromBranchName"]?.jsonPrimitive?.content ?: "",
                toBranchName = obj["toBranchName"]?.jsonPrimitive?.content ?: "",
                status = obj["status"]?.jsonPrimitive?.content ?: "dispatched",
                note = obj["note"]?.jsonPrimitive?.contentOrNull,
                approvalNote = obj["approvalNote"]?.jsonPrimitive?.contentOrNull,
                dispatchedAt = obj["dispatchedAt"]?.jsonPrimitive?.content ?: "",
                receivedAt = obj["receivedAt"]?.jsonPrimitive?.contentOrNull,
                lineCount = obj["lineCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                inTransitQuantity = obj["inTransitQuantity"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                shortageQuantity = obj["shortageQuantity"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                lines = obj["lines"]?.jsonArray?.map { lineElement ->
                    val line = lineElement.jsonObject
                    ServerTransferLine(
                        productId = line["productId"]?.jsonPrimitive?.content ?: "",
                        sku = line["sku"]?.jsonPrimitive?.content ?: "",
                        name = line["name"]?.jsonPrimitive?.content ?: "",
                        unit = line["unit"]?.jsonPrimitive?.content ?: "",
                        enteredUnit = line["enteredUnit"]?.jsonPrimitive?.contentOrNull,
                        enteredQuantity = line["enteredQuantity"]?.jsonPrimitive?.content?.toDoubleOrNull(),
                        dispatched = line["dispatched"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                        received = line["received"]?.jsonPrimitive?.content?.toDoubleOrNull(),
                        unitCostMinor = line["unitCostMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                        shortage = line["shortage"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                    )
                } ?: emptyList(),
            )
        } ?: emptyList()
    }

    /**
     * The tenant's branches (item 4.7), read from the same config snapshot the units and brands ride
     * in — one small call that gives an offline-capable destination picker everything it needs.
     */
    suspend fun configBranches(baseUrl: String, token: String): List<ServerBranch> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "config/snapshot", token).jsonObject
        response["branches"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerBranch(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                code = obj["code"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList()
    }

    /**
     * Bulk catalogue import (item 4.4). `commit = false` is a pure preview: the server validates the
     * whole file and writes nothing, so the device can show exactly what a commit would do before
     * asking for it.
     */
    suspend fun importProducts(
        baseUrl: String,
        token: String,
        source: ImportSource,
        commit: Boolean,
        createMissingCategories: Boolean,
        createMissingBrands: Boolean = false,
    ): ImportReport = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            when (source) {
                is ImportSource.Csv -> put("csv", source.text)
                is ImportSource.Json -> put("records", recordsOf(source.text))
            }
            put("commit", commit)
            put("createMissingCategories", createMissingCategories)
            put("createMissingBrands", createMissingBrands)
        }
        post(baseUrl, "products/import", token, body).jsonObject.toImportReport()
    }

    /**
     * Opening-stock import (item 4.5). `commit = false` is a pure preview: the server validates
     * every row and writes nothing, so what is approved on screen is exactly what a commit does.
     *
     * `requestId` is generated once per file chosen and reused for the commit, which is what lets a
     * commit that times out be retried without opening the same stock a second time.
     */
    suspend fun importOpeningStock(
        baseUrl: String,
        token: String,
        branchId: String,
        requestId: String,
        source: ImportSource,
        commit: Boolean,
    ): OpeningStockReport = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("branchId", branchId)
            put("requestId", requestId)
            when (source) {
                is ImportSource.Csv -> put("csv", source.text)
                is ImportSource.Json -> put("records", recordsOf(source.text))
            }
            put("commit", commit)
        }
        post(baseUrl, "inventory/opening-stock/import", token, body).jsonObject.toOpeningStockReport()
    }

    /** A JSON file is either an array of records or an object wrapping one in `records`. */
    private fun recordsOf(text: String): JsonArray {
        val element = runCatching { json.parseToJsonElement(text) }.getOrNull()
            ?: throw ApiException(0, "INVALID_IMPORT_FILE", "That file is not valid JSON")
        return when (element) {
            is JsonArray -> element
            is JsonObject -> element["records"] as? JsonArray ?: throw ApiException(0, "INVALID_IMPORT_FILE", "A JSON import must be an array of records")
            else -> throw ApiException(0, "INVALID_IMPORT_FILE", "A JSON import must be an array of records")
        }
    }

    private fun JsonObject.toImportReport(): ImportReport = ImportReport(
        status = this["status"]?.jsonPrimitive?.content ?: "invalid",
        rowCount = this["rowCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        validCount = this["validCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        errorCount = this["errorCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        createCount = this["createCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        updateCount = this["updateCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        categoriesToCreate = this["categoriesToCreate"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
        brandsToCreate = this["brandsToCreate"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
        errors = this["errors"]?.jsonArray?.map { element ->
            val error = element.jsonObject
            ImportRowError(
                line = error["line"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                sku = error["sku"]?.jsonPrimitive?.contentOrNull,
                field = error["field"]?.jsonPrimitive?.contentOrNull,
                code = error["code"]?.jsonPrimitive?.content ?: "",
                message = error["message"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList(),
        preview = this["preview"]?.jsonArray?.map { element ->
            val row = element.jsonObject
            ImportPreviewRow(
                line = row["line"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                action = row["action"]?.jsonPrimitive?.content ?: "",
                sku = row["sku"]?.jsonPrimitive?.content ?: "",
                name = row["name"]?.jsonPrimitive?.content ?: "",
                priceMinor = row["priceMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                unit = row["unit"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList(),
        previewTruncated = this["previewTruncated"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
    )

    private fun JsonObject.toOpeningStockReport(): OpeningStockReport = OpeningStockReport(
        status = this["status"]?.jsonPrimitive?.content ?: "invalid",
        alreadyApplied = this["alreadyApplied"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
        rowCount = this["rowCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        validCount = this["validCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        errorCount = this["errorCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        warningCount = this["warningCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        totalQuantity = this["totalQuantity"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
        totalValueMinor = this["totalValueMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
        errors = this["errors"]?.jsonArray?.map { element ->
            val error = element.jsonObject
            ImportRowError(
                line = error["line"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                sku = error["sku"]?.jsonPrimitive?.contentOrNull,
                field = error["field"]?.jsonPrimitive?.contentOrNull,
                code = error["code"]?.jsonPrimitive?.content ?: "",
                message = error["message"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList(),
        warnings = this["warnings"]?.jsonArray?.map { element ->
            val warning = element.jsonObject
            OpeningStockWarning(
                line = warning["line"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                sku = warning["sku"]?.jsonPrimitive?.contentOrNull,
                field = warning["field"]?.jsonPrimitive?.contentOrNull,
                code = warning["code"]?.jsonPrimitive?.content ?: "",
                message = warning["message"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList(),
        preview = this["preview"]?.jsonArray?.map { element ->
            val row = element.jsonObject
            OpeningStockPreviewRow(
                line = row["line"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                sku = row["sku"]?.jsonPrimitive?.content ?: "",
                name = row["name"]?.jsonPrimitive?.content ?: "",
                unit = row["unit"]?.jsonPrimitive?.content ?: "",
                quantity = row["quantity"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                enteredUnit = row["enteredUnit"]?.jsonPrimitive?.contentOrNull,
                enteredQuantity = row["enteredQuantity"]?.jsonPrimitive?.content?.toDoubleOrNull(),
                onHandBefore = row["onHandBefore"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                onHandAfter = row["onHandAfter"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                unitCostMinor = row["unitCostMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                valueMinor = row["valueMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                costWasGiven = row["costWasGiven"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
            )
        } ?: emptyList(),
        previewTruncated = this["previewTruncated"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
    )

    /**
     * Movement history straight from the server. This is deliberately NOT cached for offline reading:
     * the device holds the current on-hand projection, not a full branch movement ledger, and inventing
     * one locally would mean showing history that may not match what the server posted.
     */
    suspend fun inventoryMovements(baseUrl: String, token: String, productId: String): List<ServerMovement> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "inventory/movements?limit=200&productId=$productId", token).jsonObject
        response["movements"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerMovement(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                productId = obj["product_id"]?.jsonPrimitive?.content ?: "",
                sku = obj["sku"]?.jsonPrimitive?.content ?: "",
                quantityDelta = obj["quantity_delta"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0,
                unit = obj["unit"]?.jsonPrimitive?.content ?: "",
                enteredUnit = obj["entered_unit"]?.jsonPrimitive?.contentOrNull,
                enteredQuantity = obj["entered_quantity"]?.jsonPrimitive?.content?.toDoubleOrNull(),
                reason = obj["reason"]?.jsonPrimitive?.contentOrNull,
                sourceType = obj["source_type"]?.jsonPrimitive?.content ?: "",
                sourceId = obj["source_id"]?.jsonPrimitive?.contentOrNull,
                cogsMinor = obj["cogs_minor"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
                actorId = obj["actor_id"]?.jsonPrimitive?.contentOrNull,
                actorName = obj["actor_name"]?.jsonPrimitive?.contentOrNull,
                occurredAt = obj["occurred_at"]?.jsonPrimitive?.content ?: "",
            )
        } ?: emptyList()
    }

    suspend fun status(baseUrl: String, token: String): JsonObject = withContext(Dispatchers.IO) {
        get(baseUrl, "sync/status", token).jsonObject
    }

    // --- the drawer and the role gate (item 5.2, D10) ----------------------------------------------

    /**
     * The signed-in user's permission codes, cached at sign-in so the till can gate itself OFFLINE
     * (§6). The server re-checks every one of them on the push path regardless — a cached list is
     * a courtesy to the cashier, never the authority.
     */
    suspend fun authMe(baseUrl: String, token: String): List<String> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "auth/me", token).jsonObject
        response["permissions"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
    }

    /** The drawer this branch is trading from right now, or null. */
    suspend fun cashSessionCurrent(baseUrl: String, token: String, branchId: String): ServerCashSession? = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "cash/sessions/current?branchId=$branchId", token).jsonObject
        val row = response["session"] as? JsonObject ?: return@withContext null
        ServerCashSession(
            id = row["id"]?.jsonPrimitive?.content ?: return@withContext null,
            branchId = row["branchId"]?.jsonPrimitive?.content ?: "",
            state = row["state"]?.jsonPrimitive?.content ?: "open",
            openingFloatMinor = row["openingFloatMinor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
            countedMinor = row["countedMinor"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
            expectedMinor = row["expectedMinor"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
            varianceMinor = row["varianceMinor"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
            openedAt = row["openedAt"]?.jsonPrimitive?.content ?: "",
            closedAt = row["closedAt"]?.jsonPrimitive?.contentOrNull,
        )
    }
}

/** The server's view of a drawer session (item 5.2). Money in minor units, timestamps ISO-8601. */
data class ServerCashSession(
    val id: String,
    val branchId: String,
    val state: String,
    val openingFloatMinor: Long,
    val countedMinor: Long?,
    val expectedMinor: Long?,
    val varianceMinor: Long?,
    val openedAt: String,
    val closedAt: String?,
)
