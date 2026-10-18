package com.kiosk.erp.feature.pos

import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * Full-screen offline barcode scanner (§5 POS).
 *
 * Uses the BUNDLED ML Kit model, so a scan needs no network and no Google Play Services. The POS
 * keeps a manual-entry path because a device may have no usable camera (or the code may be damaged).
 *
 * `onCode` resolves the code and reports the outcome: `true` means the code was handled and the
 * scanner closes; `false` keeps it open and shows the reason, so a scan never looks like nothing
 * happened.
 */
@Composable
fun BarcodeScannerOverlay(
    onCode: (String, (Boolean) -> Unit) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    var manualEntry by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var lastCode by remember { mutableStateOf<String?>(null) }
    var resolving by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }

    LaunchedEffect(Unit) {
        if (!granted) launcher.launch(Manifest.permission.CAMERA)
    }

    fun resolve(code: String) {
        if (resolving || code.isBlank()) return
        resolving = true
        status = null
        onCode(code) { handled ->
            resolving = false
            if (handled) {
                onDismiss()
            } else {
                status = "No product matches $code. Refresh the catalogue if it is new."
            }
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            CameraPreview(Modifier.fillMaxSize()) { code ->
                if (code != lastCode) {
                    lastCode = code
                    resolve(code)
                }
            }
        } else {
            Text(
                "Camera permission is required to scan. Use manual entry instead.",
                color = Color.White,
                modifier = Modifier.align(Alignment.Center).padding(24.dp),
            )
        }

        Surface(
            color = Color.Black.copy(alpha = 0.55f),
            modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth(),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (granted) "Point the camera at the barcode" else "Camera unavailable",
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                )
                status?.let { Text(it, color = Color(0xFFFFCC80)) }
            }
        }

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(onClick = { manualEntry = true }, modifier = Modifier.fillMaxWidth()) { Text("Enter code manually") }
            OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Close") }
        }
    }

    if (manualEntry) {
        ManualCodeDialog(
            onSubmit = {
                manualEntry = false
                resolve(it)
            },
            onDismiss = { manualEntry = false },
        )
    }
}

@Composable
private fun ManualCodeDialog(onSubmit: (String) -> Unit, onDismiss: () -> Unit) {
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Enter barcode") },
        text = {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text("Barcode") },
                singleLine = true,
            )
        },
        confirmButton = {
            TextButton(onClick = { if (code.isNotBlank()) onSubmit(code.trim()) }) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private const val TAG = "KioskBarcodeScanner"

@Composable
private fun CameraPreview(modifier: Modifier, onBarcode: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember {
        PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val currentOnBarcode by rememberUpdatedState(onBarcode)

    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(
                    Barcode.FORMAT_EAN_13,
                    Barcode.FORMAT_EAN_8,
                    Barcode.FORMAT_UPC_A,
                    Barcode.FORMAT_UPC_E,
                    Barcode.FORMAT_CODE_128,
                    Barcode.FORMAT_CODE_39,
                    Barcode.FORMAT_CODE_93,
                    Barcode.FORMAT_ITF,
                    Barcode.FORMAT_CODABAR,
                    Barcode.FORMAT_QR_CODE,
                )
                .build(),
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            executor.shutdown()
            scanner.close()
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)

    LaunchedEffect(previewView, lifecycleOwner) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener(
            {
                val provider = providerFuture.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                // A higher analysis resolution than the 640x480 default matters a lot for small retail
                // barcodes; 16:9 falls back to whatever the device actually supports.
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                            .build(),
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(executor) { imageProxy -> analyse(scanner, imageProxy, currentOnBarcode) }
                try {
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (err: Exception) {
                    // Never fail silently: an unbound camera used to look like "nothing is happening".
                    Log.w(TAG, "Camera bind failed", err)
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }
}

@Suppress("UnsafeOptInUsageError")
private fun analyse(
    scanner: BarcodeScanner,
    imageProxy: ImageProxy,
    onBarcode: (String) -> Unit,
) {
    val mediaImage = imageProxy.image
    if (mediaImage == null) {
        imageProxy.close()
        return
    }
    val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    scanner.process(input)
        .addOnSuccessListener { barcodes ->
            barcodes.firstOrNull { !it.rawValue.isNullOrBlank() }?.rawValue?.let(onBarcode)
        }
        .addOnFailureListener { err -> Log.w(TAG, "Barcode analysis failed", err) }
        .addOnCompleteListener { imageProxy.close() }
}
