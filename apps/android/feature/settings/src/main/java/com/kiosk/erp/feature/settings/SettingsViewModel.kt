package com.kiosk.erp.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.Session
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.data.sync.SyncEngine
import com.kiosk.erp.core.network.ApiClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SettingsUiState(
    val apiBaseUrl: String = "",
    val email: String = "",
    val password: String = "",
    val branchId: String = "",
    val deviceId: String = "",
    val message: String? = null,
    val configured: Boolean = false,
    val busy: Boolean = false,
) {
    /** Everything setup needs is already on screen. */
    val fieldsComplete: Boolean
        get() = apiBaseUrl.isNotBlank() &&
            email.isNotBlank() &&
            password.isNotBlank() &&
            branchId.isNotBlank() &&
            deviceId.isNotBlank()

    /** Setup is a single tap only if everything it needs is present and no run is in flight. */
    val canEnrol: Boolean get() = fieldsComplete && !busy
}

class SettingsViewModel(
    private val api: ApiClient,
    private val sessionStore: SessionStore,
    private val saleRepository: SaleRepository,
    private val syncEngine: SyncEngine,
    private val appVersion: String,
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state

    init {
        viewModelScope.launch {
            val session = sessionStore.current()
            _state.update {
                it.copy(
                    apiBaseUrl = session.apiBaseUrl,
                    email = session.email ?: "",
                    branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222",
                    deviceId = session.deviceId ?: java.util.UUID.randomUUID().toString(),
                    configured = session.canSync,
                )
            }
        }
    }

    fun update(transform: (SettingsUiState) -> SettingsUiState) = _state.update(transform)

    /** Show where setup has got to, not just that something is happening. */
    private fun step(text: String) = _state.update { it.copy(message = text, busy = true) }

    /** One-tap setup: login, enroll the device, re-login bound to the device, then pull the data. */
    fun setup() {
        val s = _state.value
        if (s.busy) return
        if (!s.fieldsComplete) {
            _state.update { it.copy(message = "Fill in the address, email, password and identifiers first.") }
            return
        }
        viewModelScope.launch {
            step("Signing in…")
            runCatching {
                val base = s.apiBaseUrl.trim()
                // Login unbound to obtain a token for enrollment.
                val unbound = api.login(base, s.email.trim(), s.password, null)
                step("Enrolling this device…")
                api.enrollDevice(base, unbound.accessToken, s.deviceId.trim(), s.branchId.trim(), "Kiosk till", appVersion)
                // Re-login bound to the device so queued commands carry the device id.
                step("Finishing…")
                val bound = api.login(base, s.email.trim(), s.password, s.deviceId.trim())
                sessionStore.save(
                    Session(
                        apiBaseUrl = base,
                        accessToken = bound.accessToken,
                        refreshToken = bound.refreshToken,
                        tenantId = bound.tenantId,
                        userId = bound.userId,
                        email = s.email.trim(),
                        deviceId = s.deviceId.trim(),
                        branchId = s.branchId.trim(),
                    ),
                )
                saleRepository.ensureSyncState()
            }.onSuccess {
                _state.update { it.copy(message = "Device enrolled — pulling the catalogue and stock…", configured = true, busy = true) }
                firstSync()
            }.onFailure { err ->
                _state.update { it.copy(message = "Setup failed: ${err.message}", busy = false) }
            }
        }
    }

    /**
     * The first pull after enrolment is what actually puts products on this till. A shop that was
     * already live — or the dev seed — emits no product events, so without this a brand-new device
     * would sit on an empty product list and every scan would answer "no product matches" until
     * somebody found Sync Centre by hand. It runs detached and reports separately: a device that
     * enrolled offline is still enrolled, and sync will catch up by itself later.
     */
    private fun firstSync() {
        viewModelScope.launch {
            val pulled = runCatching { syncEngine.syncNow() }.getOrNull()
            _state.update {
                when (pulled) {
                    is SyncEngine.Result.Success ->
                        it.copy(message = "Device enrolled. Catalogue and stock synced.", busy = false)
                    else ->
                        it.copy(message = "Device enrolled. It will pull the catalogue on the next sync.", busy = false)
                }
            }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }
}
