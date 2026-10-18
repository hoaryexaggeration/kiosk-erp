package com.kiosk.erp.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.VerifiedUser
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

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab("dashboard", "Home", Icons.Filled.Dashboard),
    Tab("pos", "POS", Icons.Filled.PointOfSale),
    Tab("catalog", "Catalogue", Icons.Filled.Inventory2),
    Tab("inventory", "Stock", Icons.Filled.Warehouse),
    Tab("sync", "Sync", Icons.Filled.Sync),
    Tab("license", "License", Icons.Filled.VerifiedUser),
    Tab("settings", "Setup", Icons.Filled.Settings),
)

@Composable
fun KioskNavHost(container: AppContainer) {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val factory = KioskViewModelFactory(container)

    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEach { tab ->
                    NavigationBarItem(
                        selected = currentRoute == tab.route,
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
            composable("dashboard") { DashboardScreen(viewModel(factory = factory)) }
            composable("pos") { PosScreen(viewModel(factory = factory)) }
            composable("catalog") { CatalogScreen(viewModel(factory = factory)) }
            composable("inventory") { InventoryScreen(viewModel(factory = factory)) }
            composable("sync") { SyncCenterScreen(viewModel(factory = factory)) }
            composable("license") { LicenseScreen(viewModel(factory = factory)) }
            composable("settings") { SettingsScreen(viewModel(factory = factory)) }
        }
    }
}
