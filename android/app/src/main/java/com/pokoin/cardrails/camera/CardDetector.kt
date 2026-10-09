package com.pokoin.cardrails.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import com.pokoin.cardrails.engine.Point
import org.tensorflow.lite.Interpreter
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** An upright 448×448 card crop and its box in normalized frame coordinates. */
data class DetectedCard(val image: Bitmap, val quad: List<Point>, val confidence: Float)

/**
 * TCG YOLO11n card detector (same model as BattleScan / Pokoin): RGB 0–1 NHWC
 * (1,640,640,3) in, (1,5,8400) = cx, cy, w, h, conf in 640-px space out.
 */
class CardDetector(context: Context) : AutoCloseable {
    private val interpreter: Interpreter
    private val input = ByteBuffer.allocateDirect(SIZE * SIZE * 3 * 4).order(ByteOrder.nativeOrder())
    private val pixels = IntArray(SIZE * SIZE)
    private val output = Array(1) { Array(5) { FloatArray(ANCHORS) } }

    init {
        val bytes = context.assets.open("models/card_detector.tflite").use { it.readBytes() }
        val model = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply { put(bytes); rewind() }
        interpreter = Interpreter(model, Interpreter.Options().apply { setNumThreads(4); setUseXNNPACK(true) })
    }

    @Synchronized
    fun detect(frame: Bitmap): DetectedCard? {
        val resized = Bitmap.createScaledBitmap(frame, SIZE, SIZE, true)
        resized.getPixels(pixels, 0, SIZE, 0, 0, SIZE, SIZE)
        input.rewind()
        for (c in pixels) {
            input.putFloat(((c ushr 16) and 0xFF) / 255f)
            input.putFloat(((c ushr 8) and 0xFF) / 255f)
            input.putFloat((c and 0xFF) / 255f)
        }
        input.rewind()
        interpreter.run(input, output)

        val out = output[0]
        var best = -1
        var confidence = MIN_CONFIDENCE
        for (i in 0 until ANCHORS) {
            if (out[4][i] > confidence) { confidence = out[4][i]; best = i }
        }
        if (best < 0) return null
        val cx = out[0][best] / SIZE; val cy = out[1][best] / SIZE
        val w = out[2][best] / SIZE; val h = out[3][best] / SIZE
        val left = (cx - w / 2f).coerceIn(0f, 1f); val top = (cy - h / 2f).coerceIn(0f, 1f)
        val right = (cx + w / 2f).coerceIn(0f, 1f); val bottom = (cy + h / 2f).coerceIn(0f, 1f)
        if ((right - left) * (bottom - top) < MIN_AREA) return null

        val padX = (right - left) * .02f; val padY = (bottom - top) * .02f
        val l = ((left - padX).coerceAtLeast(0f) * frame.width).toInt()
        val t = ((top - padY).coerceAtLeast(0f) * frame.height).toInt()
        val r = ((right + padX).coerceAtMost(1f) * frame.width).toInt()
        val b = ((bottom + padY).coerceAtMost(1f) * frame.height).toInt()
        if (r - l < 16 || b - t < 16) return null
        var crop = Bitmap.createBitmap(frame, l, t, r - l, b - t)
        if (crop.width > crop.height) {
            crop = Bitmap.createBitmap(crop, 0, 0, crop.width, crop.height, Matrix().apply { postRotate(90f) }, true)
        }
        crop = Bitmap.createScaledBitmap(crop, 448, 448, true)
        return DetectedCard(
            crop,
            listOf(Point(left, top), Point(right, top), Point(right, bottom), Point(left, bottom)),
            confidence,
        )
    }

    override fun close() = interpreter.close()

    companion object {
        private const val SIZE = 640
        private const val ANCHORS = 8400
        private const val MIN_CONFIDENCE = .35f
        private const val MIN_AREA = .01f
    }
}
