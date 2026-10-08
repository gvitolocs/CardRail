package com.pokoin.cardrails.camera

import android.content.Context
import android.util.Size
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Binds preview + analysis to the lifecycle; analysis runs on its own thread. */
class CameraController(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val preview: PreviewView,
    private val analyzer: ImageAnalysis.Analyzer,
) {
    private var executor: ExecutorService? = null
    private var camera: Camera? = null
    private var provider: ProcessCameraProvider? = null

    fun start() {
        val pool = Executors.newSingleThreadExecutor().also { executor = it }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val cameraProvider = future.get().also { provider = it }
            val previewCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                        .build(),
                )
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .build()
                .also { it.setAnalyzer(pool, analyzer) }
            cameraProvider.unbindAll()
            camera = cameraProvider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, previewCase, analysis)
        }, ContextCompat.getMainExecutor(context))
    }

    fun setTorch(enabled: Boolean) {
        camera?.cameraControl?.enableTorch(enabled)
    }

    fun stop() {
        camera?.cameraControl?.enableTorch(false)
        provider?.unbindAll()
        executor?.shutdown()
        executor = null
        camera = null
    }
}
