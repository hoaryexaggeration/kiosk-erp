package com.kiosk.erp.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
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

    private fun get(baseUrl: String, path: String, token: String?): JsonElement {
        val builder = Request.Builder().url(url(baseUrl, path)).get()
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

    suspend fun login(baseUrl: String, email: String, password: String, deviceId: String?): JsonObject = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("email", email)
            put("password", password)
            if (deviceId != null) put("deviceId", deviceId)
        }
        post(baseUrl, "auth/login", null, body).jsonObject
    }

    suspend fun enrollDevice(baseUrl: String, token: String, deviceId: String, branchId: String, name: String): JsonObject =
        withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                put("deviceId", deviceId)
                put("branchId", branchId)
                put("name", name)
                put("platform", "android")
                put("isOfflineAuthoritative", true)
                put("appVersion", "0.3.0")
            }
            post(baseUrl, "devices/enroll", token, body).jsonObject
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
        response["products"]?.jsonArray?.map { element ->
            val obj = element.jsonObject
            ServerProduct(
                id = obj["id"]?.jsonPrimitive?.content ?: "",
                sku = obj["sku"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
                unit = obj["unit"]?.jsonPrimitive?.content ?: "ea",
                priceMinor = obj["price_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                costMinor = obj["cost_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                version = obj["version"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1,
                taxRateBp = obj["tax_rate_bp"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                taxInclusive = obj["tax_inclusive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
            )
        } ?: emptyList()
    }

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
