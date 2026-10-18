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
    val isStockTracked: Boolean = true,
    val isActive: Boolean = true,
)

data class ServerCategory(val id: String, val name: String, val parentId: String? = null)

data class ServerTaxCategory(val id: String, val name: String, val rateBp: Int, val inclusive: Boolean)

/**
 * Everything the catalogue editor can set. `barcodes` is the FULL desired set — the server replaces
 * what it holds (item 4.1), so removing a tag here removes it everywhere after sync.
 * `expectedVersion` carries the optimistic-concurrency check so a stale edit cannot silently win.
 */
data class ProductDraft(
    val id: String?,
    val sku: String,
    val name: String,
    val description: String? = null,
    val categoryId: String? = null,
    val taxCategoryId: String? = null,
    val unit: String = "ea",
    val priceMinor: Long = 0,
    val costMinor: Long = 0,
    val isStockTracked: Boolean = true,
    val isActive: Boolean = true,
    val barcodes: List<String> = emptyList(),
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

    suspend fun serverProducts(baseUrl: String, token: String): List<ServerProduct> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "products?limit=500", token).jsonObject
        response["products"]?.jsonArray?.map { it.jsonObject.toServerProduct() } ?: emptyList()
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
     * `POST /products` rejects an explicit null for description/category/tax (only `undefined` is
     * accepted), so a create omits absent optionals while an update sends null to clear them.
     */
    private fun productBody(draft: ProductDraft, forCreate: Boolean): JsonObject = buildJsonObject {
        put("sku", draft.sku)
        put("name", draft.name)
        put("unit", draft.unit)
        put("priceMinor", draft.priceMinor)
        put("costMinor", draft.costMinor)
        put("isStockTracked", draft.isStockTracked)
        put("barcodes", JsonArray(draft.barcodes.map { JsonPrimitive(it) }))
        if (forCreate) {
            draft.description?.let { put("description", it) }
            draft.categoryId?.let { put("categoryId", it) }
            draft.taxCategoryId?.let { put("taxCategoryId", it) }
        } else {
            put("description", draft.description)
            put("categoryId", draft.categoryId)
            put("taxCategoryId", draft.taxCategoryId)
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
        isStockTracked = this["is_stock_tracked"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
        isActive = this["is_active"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
    )

    suspend fun inventoryBalances(baseUrl: String, token: String): List<ServerBalance> = withContext(Dispatchers.IO) {
        val response = get(baseUrl, "inventory/balances?limit=500", token).jsonObject
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

    suspend fun status(baseUrl: String, token: String): JsonObject = withContext(Dispatchers.IO) {
        get(baseUrl, "sync/status", token).jsonObject
    }
}
