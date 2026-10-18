package com.kiosk.erp.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.kiosk.erp.data.local.OutboxEntity
import com.kiosk.erp.data.local.ProductEntity
import com.kiosk.erp.data.local.SaleEntity
import com.kiosk.erp.data.local.SyncStateEntity
import com.kiosk.erp.data.repository.CartLine
import com.kiosk.erp.di.AppContainer
import com.kiosk.erp.domain.Pricing
import com.kiosk.erp.security.LicensePayload
import com.kiosk.erp.security.LicenseVerifier
import com.kiosk.erp.sync.SyncEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class DashboardViewModel(container: AppContainer) : ViewModel() {
    val grossMinor: StateFlow<Long> = container.saleRepository.observeGrossTotalMinor()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)
    val pendingCount: StateFlow<Int> = container.saleRepository.observePendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val attentionCount: StateFlow<Int> = container.saleRepository.observeNeedsAttentionCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val syncState: StateFlow<SyncStateEntity?> = container.saleRepository.observeSyncState()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    val recentSales: StateFlow<List<SaleEntity>> = container.saleRepository.observeRecentSales()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}

class SyncViewModel(private val container: AppContainer) : ViewModel() {
    val pendingCount: StateFlow<Int> = container.saleRepository.observePendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)
    val attention: StateFlow<List<OutboxEntity>> = container.saleRepository.observeNeedsAttention()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val syncState: StateFlow<SyncStateEntity?> = container.saleRepository.observeSyncState()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    val oldestPending: StateFlow<Long?> = container.saleRepository.observeOldestPending()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun syncNow() {
        viewModelScope.launch {
            _message.value = "Syncing…"
            when (val result = container.syncEngine.syncNow()) {
                is SyncEngine.Result.Success -> _message.value = "Pushed ${result.pushed}, pulled ${result.pulled}${if (result.needsAttention > 0) ", ${result.needsAttention} need attention" else ""}"
                is SyncEngine.Result.NotConfigured -> _message.value = "Not configured — set up the device in Settings"
                is SyncEngine.Result.Failure -> _message.value = "Sync failed: ${result.message}"
            }
        }
    }

    /** Phase 3 checkpoint: write a command straight to the local DB + outbox, fully offline. */
    fun createTestCommand() {
        viewModelScope.launch {
            val session = container.sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            val result = container.saleRepository.createCashSale(
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

class CatalogViewModel(private val container: AppContainer) : ViewModel() {
    val products: StateFlow<List<ProductEntity>> = container.database.productDao().observeAll()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun refreshFromServer() {
        viewModelScope.launch {
            val session = container.sessionStore.current()
            if (!session.isAuthenticated) {
                _message.value = "Sign in first (Settings) to refresh the catalogue"
                return@launch
            }
            runCatching { container.api.serverProducts(session.apiBaseUrl, session.accessToken!!) }
                .onSuccess { products ->
                    container.saleRepository.refreshProducts(products)
                    _message.value = "Cached ${products.size} products for offline use"
                }
                .onFailure { _message.value = "Refresh failed: ${it.message}" }
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}

class PosViewModel(private val container: AppContainer) : ViewModel() {
    val products: StateFlow<List<ProductEntity>> = container.database.productDao().observeAll()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _cart = MutableStateFlow<List<CartLine>>(emptyList())
    val cart: StateFlow<List<CartLine>> = _cart

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun totals(): Pricing.DocumentTotals =
        Pricing.computeDocument(_cart.value.map { Pricing.LineInput(it.unitPriceMinor, it.quantity, it.discountBp, it.taxRateBp, it.taxInclusive) })

    fun addProduct(product: ProductEntity) {
        _cart.update { current ->
            val index = current.indexOfFirst { it.productId == product.id }
            if (index >= 0) {
                current.toMutableList().also { it[index] = it[index].copy(quantity = it[index].quantity + 1) }
            } else {
                current + CartLine(product.id, product.sku, product.name, product.unit, 1.0, product.priceMinor, 0, product.taxRateBp, product.taxInclusive)
            }
        }
    }

    fun addTestItem() {
        _cart.update { it + CartLine(null, "CUSTOM", "Custom item", "ea", 1.0, 1000, 0, 1600, true) }
    }

    fun removeAt(index: Int) {
        _cart.update { current -> current.filterIndexed { i, _ -> i != index } }
    }

    fun clearCart() {
        _cart.value = emptyList()
    }

    fun checkout(onDone: (String) -> Unit) {
        viewModelScope.launch {
            val session = container.sessionStore.current()
            val branchId = session.branchId ?: "22222222-2222-4222-8222-222222222222"
            val deviceId = session.deviceId ?: "00000000-0000-4000-8000-000000000000"
            if (_cart.value.isEmpty()) {
                _message.value = "Cart is empty"
                return@launch
            }
            val result = container.saleRepository.createCashSale(null, _cart.value, branchId, deviceId)
            _message.value = "Saved on this device: ${result.localNumber} • ${Pricing.formatMinor(result.totalMinor)} KES (waiting to sync)"
            _cart.value = emptyList()
            onDone(result.localNumber)
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}

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

data class SettingsUiState(
    val apiBaseUrl: String = "",
    val email: String = "",
    val password: String = "",
    val branchId: String = "",
    val deviceId: String = "",
    val message: String? = null,
    val configured: Boolean = false,
)

class SettingsViewModel(private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state

    init {
        viewModelScope.launch {
            val session = container.sessionStore.current()
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
                container.api.login(base, s.email.trim(), s.password, null)
                val first = container.sessionStore.current()
                // Persist the base URL before enrolling so the token is usable.
                container.sessionStore.save(
                    first.copy(
                        apiBaseUrl = base,
                        accessToken = first.accessToken,
                    ),
                )
                val loginBody = container.api.login(base, s.email.trim(), s.password, null)
                val token = loginBody["accessToken"]?.toString()?.trim('"') ?: error("No token")
                container.api.enrollDevice(base, token, s.deviceId.trim(), s.branchId.trim(), "Kiosk till")
                val bound = container.api.login(base, s.email.trim(), s.password, s.deviceId.trim())
                val access = bound["accessToken"]?.toString()?.trim('"') ?: error("No access token")
                val refresh = bound["refreshToken"]?.toString()?.trim('"')
                val user = bound["user"]?.let { it as? kotlinx.serialization.json.JsonObject }
                val tenantId = user?.get("tenantId")?.toString()?.trim('"')
                val userId = user?.get("id")?.toString()?.trim('"')
                container.sessionStore.save(
                    com.kiosk.erp.data.session.Session(
                        apiBaseUrl = base,
                        accessToken = access,
                        refreshToken = refresh,
                        tenantId = tenantId,
                        userId = userId,
                        email = s.email.trim(),
                        deviceId = s.deviceId.trim(),
                        branchId = s.branchId.trim(),
                    ),
                )
                container.saleRepository.ensureSyncState()
            }.onSuccess {
                _state.update { it.copy(message = "Device enrolled and ready to sync", configured = true) }
            }.onFailure { err ->
                _state.update { it.copy(message = "Setup failed: ${err.message}") }
            }
        }
    }
}

@Suppress("UNCHECKED_CAST")
class KioskViewModelFactory(private val container: AppContainer) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T = when {
        modelClass.isAssignableFrom(DashboardViewModel::class.java) -> DashboardViewModel(container)
        modelClass.isAssignableFrom(SyncViewModel::class.java) -> SyncViewModel(container)
        modelClass.isAssignableFrom(CatalogViewModel::class.java) -> CatalogViewModel(container)
        modelClass.isAssignableFrom(PosViewModel::class.java) -> PosViewModel(container)
        modelClass.isAssignableFrom(LicenseViewModel::class.java) -> LicenseViewModel()
        modelClass.isAssignableFrom(SettingsViewModel::class.java) -> SettingsViewModel(container)
        else -> throw IllegalArgumentException("Unknown ViewModel: ${modelClass.name}")
    } as T
}
