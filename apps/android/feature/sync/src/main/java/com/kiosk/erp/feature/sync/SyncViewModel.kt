package com.kiosk.erp.feature.sync

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.CartLine
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.data.sync.SyncEngine
import com.kiosk.erp.core.database.OutboxEntity
import com.kiosk.erp.core.database.SyncStateEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SyncViewModel(
    private val syncEngine: SyncEngine,
    private val saleRepository: SaleRepository,
    private val sessionStore: SessionStore,
) : ViewModel() {

    val pendingCount: StateFlow<Int> = saleRepository.observePendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val attention: StateFlow<List<OutboxEntity>> = saleRepository.observeNeedsAttention()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val syncState: StateFlow<SyncStateEntity?> = saleRepository.observeSyncState()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    val oldestPending: StateFlow<Long?> = saleRepository.observeOldestPending()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun syncNow() {
        viewModelScope.launch {
            _message.value = "Syncing…"
            when (val result = syncEngine.syncNow()) {
                is SyncEngine.Result.Success -> _message.value = "Pushed ${result.pushed}, pulled ${result.pulled}${if (result.needsAttention > 0) ", ${result.needsAttention} need attention" else ""}"
                is SyncEngine.Result.NotConfigured -> _message.value = "Not configured — set up the device in Settings"
                is SyncEngine.Result.Failure -> _message.value = "Sync failed: ${result.message}"
            }
        }
    }

    /** Diagnostics helper: write a command straight to the local DB + outbox, fully offline. */
    fun createTestCommand() {
        viewModelScope.launch {
            val session = sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            val result = saleRepository.createCashSale(
                customerId = null,
                lines = listOf(CartLine(null, "TEST-001", "Offline test item", "ea", 1.0, 1000, 0, 1600, true)),
                branchId = branchId,
                deviceId = deviceId,
            )
            _message.value = "Saved on this device: ${result.localNumber} (waiting to sync)"
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
