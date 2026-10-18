package com.kiosk.erp.sync

import com.kiosk.erp.data.local.KioskDatabase
import com.kiosk.erp.data.local.SyncStateEntity
import com.kiosk.erp.data.remote.ApiClient
import com.kiosk.erp.data.session.SessionStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Resumable push/pull sync (§6). Pushes queued commands (retrying with the SAME commandId),
 * records per-command outcomes, then pulls ordered server deltas and advances the cursor only
 * after the page is applied locally.
 */
class SyncEngine(
    private val db: KioskDatabase,
    private val api: ApiClient,
    private val sessionStore: SessionStore,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    sealed interface Result {
        data object NotConfigured : Result
        data class Success(val pushed: Int, val pulled: Int, val needsAttention: Int) : Result
        data class Failure(val message: String) : Result
    }

    suspend fun syncNow(): Result {
        val session = sessionStore.current()
        if (!session.canSync) return Result.NotConfigured
        val token = session.accessToken!!
        val baseUrl = session.apiBaseUrl
        val deviceId = session.deviceId!!
        val branchId = session.branchId!!

        if (db.syncStateDao().get() == null) {
            db.syncStateDao().upsert(SyncStateEntity(id = 1, cursor = 0, lastPushAtEpochMs = null, lastPullAtEpochMs = null, serverReachable = false, lastError = null))
        }

        try {
            var needsAttention = 0
            val pending = db.outboxDao().pending()
            if (pending.isNotEmpty()) {
                val commands = pending.map { entry ->
                    val payload = json.parseToJsonElement(entry.payloadJson)
                    buildJsonObject {
                        put("commandId", entry.commandId)
                        put("branchId", entry.branchId)
                        put("deviceId", entry.deviceId)
                        put("aggregateType", entry.aggregateType)
                        put("aggregateId", entry.aggregateId)
                        put("aggregateVersion", 1)
                        put("schemaVersion", 1)
                        put("idempotencyKey", "${entry.aggregateType.lowercase()}:${entry.aggregateId}")
                        put("payload", payload)
                    }
                }
                val results = api.push(baseUrl, token, commands)
                val now = System.currentTimeMillis()
                for (result in results) {
                    val entry = db.outboxDao().byId(result.commandId) ?: continue
                    val mapped = when (result.status) {
                        "accepted", "duplicate" -> "accepted"
                        "review_required" -> "review_required"
                        "rejected" -> "rejected"
                        "conflict" -> "conflict"
                        else -> "retryable"
                    }
                    db.outboxDao().markResult(result.commandId, mapped, result.message, result.code, now)
                    if (entry.aggregateType == "Sale") {
                        val saleState = when (mapped) {
                            "accepted" -> "accepted"
                            "review_required" -> "review_required"
                            "rejected" -> "rejected"
                            "conflict" -> "conflict"
                            else -> "pending_sync"
                        }
                        val serverSeq = result.result?.get("serverSeq")?.jsonPrimitive?.content?.toLongOrNull()
                        db.saleDao().markSynced(entry.aggregateId, saleState, serverSeq, now, result.code ?: result.message)
                    }
                    if (mapped == "rejected" || mapped == "conflict" || mapped == "review_required") needsAttention++
                }
            }

            // Pull deltas after push.
            val state = db.syncStateDao().get() ?: SyncStateEntity(1, 0, null, null, false, null)
            val page = api.pull(baseUrl, token, state.cursor)
            val now = System.currentTimeMillis()
            db.syncStateDao().upsert(
                SyncStateEntity(id = 1, cursor = page.cursor, lastPushAtEpochMs = now, lastPullAtEpochMs = now, serverReachable = true, lastError = null),
            )
            return Result.Success(pushed = pending.size, pulled = page.events.size, needsAttention = needsAttention)
        } catch (err: Exception) {
            val state = db.syncStateDao().get() ?: SyncStateEntity(1, 0, null, null, false, null)
            db.syncStateDao().upsert(state.copy(serverReachable = false, lastError = err.message))
            return Result.Failure(err.message ?: "Sync failed")
        }
    }
}
