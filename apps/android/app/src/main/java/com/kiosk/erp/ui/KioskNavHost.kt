package com.kiosk.erp.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Warehouse
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.kiosk.erp.di.AppContainer
import com.kiosk.erp.feature.catalog.CatalogScreen
import com.kiosk.erp.feature.dashboard.DashboardScreen
import com.kiosk.erp.feature.inventory.InventoryScreen
import com.kiosk.erp.feature.license.LicenseScreen
import com.kiosk.erp.feature.pos.PosScreen
import com.kiosk.erp.feature.settings.SettingsScreen
import com.kiosk.erp.feature.sync.SyncCenterScreen

/**
 * Primary destinations only. Material's NavigationBar is designed for 3–5 items, so Catalogue and
 * License — which are occasional, administrative screens — are reached from the Setup hub instead of
 * getting their own tab. This keeps the cashier's core loop (Home, POS, Stock, Sync) uncluttered.
 */
private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab("dashboard", "Home", Icons.Filled.Dashboard),
    Tab("pos", "POS", Icons.Filled.PointOfSale),
    Tab("inventory", "Stock", Icons.Filled.Warehouse),
    Tab("sync", "Sync", Icons.Filled.Sync),
    Tab("settings", "Setup", Icons.Filled.Settings),
)

/** Non-tab routes and the tab that owns them, so the bar stays highlighted while browsing them. */
private val ownedByTab = mapOf(
    "catalog" to "settings",
    "license" to "settings",
)

@Composable
fun KioskNavHost(container: AppContainer) {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val selectedRoute = currentRoute?.let { ownedByTab[it] ?: it }
    val factory = KioskViewModelFactory(container)

    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEach { tab ->
                    NavigationBarItem(
                        selected = selectedRoute == tab.route,
                        onClick = {
                            navController.navigate(tab.route) {
                                popUpTo("dashboard") { inclusive = tab.route == "dashboard" }
                                launchSingleTop = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = "dashboard",
            modifier = Modifier.padding(padding),
        ) {
            composable("dashboard") {
                DashboardScreen(
                    vm = viewModel(factory = factory),
                    onOpenPos = { navController.navigate("pos") { launchSingleTop = true } },
                    onOpenSync = { navController.navigate("sync") { launchSingleTop = true } },
                    onOpenSetup = { navController.navigate("settings") { launchSingleTop = true } },
                )
            }
            composable("pos") {
                PosScreen(
                    viewModel(factory = factory),
                    onOpenCatalogue = { navController.navigate("catalog") },
                )
            }
            composable("inventory") {
                InventoryScreen(
                    viewModel(factory = factory),
                    onOpenCatalogue = { navController.navigate("catalog") },
                )
            }
            composable("sync") { SyncCenterScreen(viewModel(factory = factory)) }
            composable("settings") {
                SettingsScreen(
                    vm = viewModel(factory = factory),
                    onOpenCatalog = { navController.navigate("catalog") },
                    onOpenLicense = { navController.navigate("license") },
                )
            }
            composable("catalog") { CatalogScreen(viewModel(factory = factory)) }
            composable("license") { LicenseScreen(viewModel(factory = factory)) }
        }
    }
}
