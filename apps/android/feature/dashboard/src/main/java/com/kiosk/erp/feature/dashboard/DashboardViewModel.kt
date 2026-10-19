package com.kiosk.erp.feature.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.data.session.Session
import com.kiosk.erp.core.data.session.SessionStore
import com.kiosk.erp.core.database.SaleEntity
import com.kiosk.erp.core.database.SyncStateEntity
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn

/**
 * Home answers three questions a shopkeeper asks in this order: *how much did I take*, *is anything
 * stuck*, *what were the last few sales*.
 *
 * The two totals are kept apart on purpose (§7): `acceptedTotalMinor` is money the server has posted,
 * `pendingTotalMinor` is money this device is still carrying. Presenting one number that silently
 * mixes them would let a cashier believe unsynced cash is already in the books.
 */
class DashboardViewModel(
    saleRepository: SaleRepository,
    sessionStore: SessionStore,
) : ViewModel() {
    val acceptedTotalMinor: StateFlow<Long> = saleRepository.observeGrossTotalMinor()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)
    val pendingTotalMinor: StateFlow<Long> = saleRepository.observePendingTotalMinor()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)
    val saleCount: StateFlow<Int> = saleRepository.observeSaleCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val pendingCount: StateFlow<Int> = saleRepository.observePendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val attentionCount: StateFlow<Int> = saleRepository.observeNeedsAttentionCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val syncState: StateFlow<SyncStateEntity?> = saleRepository.observeSyncState()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    val recentSales: StateFlow<List<SaleEntity>> = saleRepository.observeRecentSales()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Enrolment state, so Home can tell an operator that this device cannot sync yet. */
    val session: StateFlow<Session?> = sessionStore.session
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
}
