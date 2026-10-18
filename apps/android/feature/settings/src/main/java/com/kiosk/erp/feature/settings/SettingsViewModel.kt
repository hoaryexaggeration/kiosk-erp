package com.kiosk.erp.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.Session
import com.kiosk.erp.core.data.session.SessionStore
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
)

class SettingsViewModel(
    private val api: ApiClient,
    private val sessionStore: SessionStore,
    private val saleRepository: SaleRepository,
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

    /** One-tap setup: login, enroll the device, then re-login bound to the device. */
    fun setup() {
        viewModelScope.launch {
            val s = _state.value
            _state.update { it.copy(message = "Signing in…") }
            runCatching {
                val base = s.apiBaseUrl.trim()
                // Login unbound to obtain a token for enrollment.
                val unbound = api.login(base, s.email.trim(), s.password, null)
                api.enrollDevice(base, unbound.accessToken, s.deviceId.trim(), s.branchId.trim(), "Kiosk till", appVersion)
                // Re-login bound to the device so queued commands carry the device id.
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
                _state.update { it.copy(message = "Device enrolled and ready to sync", configured = true) }
            }.onFailure { err ->
                _state.update { it.copy(message = "Setup failed: ${err.message}") }
            }
        }
    }
}
