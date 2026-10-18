package com.kiosk.erp.feature.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.core.data.repository.SaleRepository
import com.kiosk.erp.core.database.SaleEntity
import com.kiosk.erp.core.database.SyncStateEntity
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn

class DashboardViewModel(saleRepository: SaleRepository) : ViewModel() {
    val grossMinor: StateFlow<Long> = saleRepository.observeGrossTotalMinor()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)
    val pendingCount: StateFlow<Int> = saleRepository.observePendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val attentionCount: StateFlow<Int> = saleRepository.observeNeedsAttentionCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val syncState: StateFlow<SyncStateEntity?> = saleRepository.observeSyncState()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    val recentSales: StateFlow<List<SaleEntity>> = saleRepository.observeRecentSales()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}
