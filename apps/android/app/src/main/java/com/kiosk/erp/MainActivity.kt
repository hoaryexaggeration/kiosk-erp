package com.kiosk.erp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.kiosk.erp.ui.KioskNavHost
import com.kiosk.erp.ui.theme.KioskTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as KioskApplication).container
        setContent {
            KioskTheme {
                KioskNavHost(container)
            }
        }
    }
}
