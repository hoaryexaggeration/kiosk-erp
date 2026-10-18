package com.kiosk.erp.core.common

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Small, dependency-free time formatting shared by feature modules. Kept here so every screen
 * renders "data age" consistently (§12 requires visible freshness, never a bare green icon).
 */
object UiTime {
    fun timeAgo(epochMs: Long?): String {
        if (epochMs == null) return "never"
        val diff = (System.currentTimeMillis() - epochMs) / 1000
        return when {
            diff < 60 -> "${diff}s ago"
            diff < 3600 -> "${diff / 60}m ago"
            else -> "${diff / 3600}h ago"
        }
    }

    fun format(epochMs: Long?): String {
        if (epochMs == null) return "—"
        return SimpleDateFormat("dd MMM HH:mm", Locale.US).format(Date(epochMs))
    }
}
