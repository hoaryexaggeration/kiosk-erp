package com.kiosk.erp.core.designsystem

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Semantic colour of a status. Every place that shows state uses one of these, so "waiting" looks the
 * same on Home, Sync and Sales.
 *
 * Colour is never the only carrier of meaning (accessibility): a tinted tone is always accompanied by
 * a word or an icon that says the same thing in text.
 */
enum class Tone {
    Neutral,
    Success,
    Warning,
    Error,
    Info,
}

/**
 * Foreground colour for a tone, picked for the polarity of the current theme: dark saturated colours
 * on a light screen, bright ones on a dark screen, so a status chip stays readable in a shop window
 * at midday and on a dim screen at night.
 */
@Composable
fun toneColor(tone: Tone): Color {
    val dark = isSystemInDarkTheme()
    return when (tone) {
        Tone.Neutral -> if (dark) Color(0xFFCBD5E1) else Color(0xFF334155)
        Tone.Success -> if (dark) Color(0xFF86EFAC) else Color(0xFF166534)
        Tone.Warning -> if (dark) Color(0xFFFDE68A) else Color(0xFF854D0E)
        Tone.Error -> if (dark) Color(0xFFFCA5A5) else Color(0xFF991B1B)
        Tone.Info -> if (dark) Color(0xFF99F6E4) else Color(0xFF115E59)
    }
}

/** Same colour washed out over the surface, used as a chip or banner background. */
@Composable
fun toneColorMuted(tone: Tone): Color = toneColor(tone).copy(alpha = 0.14f)
