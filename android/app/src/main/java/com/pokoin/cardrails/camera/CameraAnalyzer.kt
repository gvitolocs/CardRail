package com.pokoin.cardrails.camera

import android.graphics.Bitmap
import android.graphics.Matrix
import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.pokoin.cardrails.engine.FrameStabilizer
import com.pokoin.cardrails.engine.Point
import com.pokoin.cardrails.engine.Recognizer
import com.pokoin.cardrails.engine.ServerScanClient
import com.pokoin.cardrails.engine.Thresholds
import com.pokoin.cardrails.engine.Verdict
import kotlin.math.hypot

/** Where a recognition ran, for the status line. */
enum class ScanPath { GPU, SERVER }

data class ScanResult(val verdict: Verdict, val crop: Bitmap, val path: ScanPath, val millis: Long)

/**
 * Frame pipeline (~12 fps): upright the frame, find the card, wait until it is held
 * still, then identify it once per placement — on the GPU when a catalog is loaded,
 * otherwise on the nezopt GPU worker behind api.pokoin.com.
 */
class CameraAnalyzer(
    private val detector: CardDetector,
    private val recognizer: () -> Recognizer?,
    private val serverCatalogId: () -> String?,
    private val server: ServerScanClient,
    private val paused: () -> Boolean,
    private val onDetection: (DetectedCard?) -> Unit,
    private val onFrameEmpty: () -> Unit,
    private val onResult: (ScanResult) -> Unit,
) : ImageAnalysis.Analyzer {
    private var lastFrameNanos = 0L
    private var emptyFrames = 0
    private var identified = false
    private var identifiedCenter: Point? = null
    private val stabilizer = FrameStabilizer()

    override fun analyze(image: ImageProxy) {
        try {
            val now = System.nanoTime()
            if (now - lastFrameNanos < FRAME_INTERVAL_NANOS || paused()) return
            lastFrameNanos = now
            val frame = upright(image)
            val card = detector.detect(frame)
            onDetection(card)
            if (card == null) {
                if (++emptyFrames >= 4) {
                    if (identified || emptyFrames == 4) onFrameEmpty()
                    identified = false
                    identifiedCenter = null
                    stabilizer.reset()
                }
                return
            }
            emptyFrames = 0
            val center = Point(card.quad.map { it.x }.average().toFloat(), card.quad.map { it.y }.average().toFloat())
            if (identified) {
                // Same card still in place: nothing to do unless it jumped (a fast swap).
                val previous = identifiedCenter ?: return
                if (hypot(center.x - previous.x, center.y - previous.y) <= NEW_PLACEMENT_JUMP) return
                identified = false
                identifiedCenter = null
                stabilizer.reset()
                onFrameEmpty()
            }
            if (!stabilizer.observe(card.quad)) return

            val started = System.nanoTime()
            val onDevice = recognizer()
            val (matches, path) = if (onDevice != null) {
                onDevice.identify(card.image) to ScanPath.GPU
            } else {
                val catalog = serverCatalogId() ?: return
                server.identify(card.image, catalog) to ScanPath.SERVER
            }
            val millis = (System.nanoTime() - started) / 1_000_000
            stabilizer.reset()
            val verdict = Thresholds.verdict(matches)
            if (verdict == Verdict.None) return  // retry on the next still frames
            identified = true
            identifiedCenter = center
            onResult(ScanResult(verdict, card.image, path, millis))
        } catch (t: Throwable) {
            Log.w("CameraAnalyzer", "frame failed", t)
        } finally {
            image.close()
        }
    }

    private fun upright(image: ImageProxy): Bitmap {
        val bitmap = image.toBitmap()  // CameraX handles row stride and RGBA
        val degrees = image.imageInfo.rotationDegrees
        if (degrees == 0) return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
    }

    companion object {
        private const val FRAME_INTERVAL_NANOS = 80_000_000L
        private const val NEW_PLACEMENT_JUMP = .15f
    }
}
