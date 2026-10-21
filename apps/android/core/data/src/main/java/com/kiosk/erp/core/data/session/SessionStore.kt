package com.kiosk.erp.core.data.session

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.sessionDataStore by preferencesDataStore(name = "session")

data class Session(
    val apiBaseUrl: String,
    val accessToken: String?,
    val refreshToken: String?,
    val tenantId: String?,
    val userId: String?,
    val email: String?,
    val deviceId: String?,
    val branchId: String?,
    /**
     * The signed-in user's permission codes, cached at sign-in so the till can gate itself while
     * offline (item 5.2). The server re-checks every one of them on the push path regardless —
     * this list decides what the CASHIER is told, never what the server allows.
     */
    val permissions: Set<String> = emptySet(),
) {
    val isAuthenticated: Boolean get() = !accessToken.isNullOrBlank()
    val canSync: Boolean get() = isAuthenticated && !deviceId.isNullOrBlank() && !branchId.isNullOrBlank()
    fun has(permission: String): Boolean = permissions.contains(permission)
}

/**
 * Device/session configuration held in DataStore (tokens should be Keystore-backed in production).
 * `defaultApiBaseUrl` is injected by the app module so this module does not depend on app BuildConfig.
 */
class SessionStore(
    private val context: Context,
    private val defaultApiBaseUrl: String,
) {
    private object Keys {
        val apiBaseUrl = stringPreferencesKey("api_base_url")
        val accessToken = stringPreferencesKey("access_token")
        val refreshToken = stringPreferencesKey("refresh_token")
        val tenantId = stringPreferencesKey("tenant_id")
        val userId = stringPreferencesKey("user_id")
        val email = stringPreferencesKey("email")
        val deviceId = stringPreferencesKey("device_id")
        val branchId = stringPreferencesKey("branch_id")
        val permissions = stringSetPreferencesKey("permissions")
    }

    val session: Flow<Session> = context.sessionDataStore.data.map { prefs ->
        Session(
            apiBaseUrl = prefs[Keys.apiBaseUrl] ?: defaultApiBaseUrl,
            accessToken = prefs[Keys.accessToken],
            refreshToken = prefs[Keys.refreshToken],
            tenantId = prefs[Keys.tenantId],
            userId = prefs[Keys.userId],
            email = prefs[Keys.email],
            deviceId = prefs[Keys.deviceId],
            branchId = prefs[Keys.branchId],
            permissions = prefs[Keys.permissions] ?: emptySet(),
        )
    }

    suspend fun current(): Session = session.first()

    suspend fun save(session: Session) {
        context.sessionDataStore.edit { prefs ->
            prefs[Keys.apiBaseUrl] = session.apiBaseUrl
            session.accessToken?.let { prefs[Keys.accessToken] = it }
            session.refreshToken?.let { prefs[Keys.refreshToken] = it }
            session.tenantId?.let { prefs[Keys.tenantId] = it }
            session.userId?.let { prefs[Keys.userId] = it }
            session.email?.let { prefs[Keys.email] = it }
            session.deviceId?.let { prefs[Keys.deviceId] = it }
            session.branchId?.let { prefs[Keys.branchId] = it }
            // An empty set means "we never learned them" — leave the previous cache untouched.
            if (session.permissions.isNotEmpty()) prefs[Keys.permissions] = session.permissions
        }
    }

    suspend fun clearAuth() {
        context.sessionDataStore.edit { prefs ->
            prefs.remove(Keys.accessToken)
            prefs.remove(Keys.refreshToken)
        }
    }
}
