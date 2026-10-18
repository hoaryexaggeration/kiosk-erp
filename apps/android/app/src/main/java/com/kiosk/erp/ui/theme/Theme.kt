package com.kiosk.erp.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color

private val Teal = Color(0xFF0F766E)
private val TealDark = Color(0xFF14B8A6)

private val LightColors = lightColorScheme(
    primary = Teal,
    secondary = Color(0xFF3F6212),
    tertiary = Color(0xFF9A3412),
)

private val DarkColors = darkColorScheme(
    primary = TealDark,
    secondary = Color(0xFFA3E635),
)

@Composable
fun KioskTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
