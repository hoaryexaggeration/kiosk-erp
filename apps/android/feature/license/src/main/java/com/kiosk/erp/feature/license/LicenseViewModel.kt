package com.kiosk.erp.feature.license

import androidx.lifecycle.ViewModel
import com.kiosk.erp.core.security.LicensePayload
import com.kiosk.erp.core.security.LicenseVerifier
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class LicenseViewModel : ViewModel() {
    private val _result = MutableStateFlow<LicensePayload?>(null)
    val result: StateFlow<LicensePayload?> = _result
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    fun verify(jws: String, publicKeyPem: String) {
        runCatching { LicenseVerifier.verify(jws.trim(), publicKeyPem.trim()) }
            .onSuccess { _result.value = it; _error.value = null }
            .onFailure { _result.value = null; _error.value = it.message ?: "Invalid package" }
    }

    fun reset() {
        _result.value = null
        _error.value = null
    }
}
