package com.pokoin.cardrails.engine

import android.content.Context
import android.graphics.Bitmap
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.gpu.CompatibilityList
import org.tensorflow.lite.gpu.GpuDelegate
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Milo CNN v22 on the LiteRT GPU delegate: raw RGB 0–255 NHWC (1,448,448,3) in,
 * L2-normalized 128-d out. When the GPU path can't start, [available] is false and
 * the app identifies cards on the nezopt server instead.
 */
class Embedder(context: Context) : AutoCloseable {
    var backend = "none"; private set
    var available = false; private set
    var reason: String? = null; private set
    private var interpreter: Interpreter? = null
    private var delegate: GpuDelegate? = null
    private val input = ByteBuffer.allocateDirect(SIZE * SIZE * 3 * 4).order(ByteOrder.nativeOrder())
    private val pixels = IntArray(SIZE * SIZE)
    private val output = Array(1) { FloatArray(DIM) }

    init {
        try {
            val compatibility = CompatibilityList()
            if (!compatibility.isDelegateSupportedOnThisDevice) {
                reason = "GPU non supportata su questo telefono"
            } else {
                val bytes = context.assets.open(MODEL).use { it.readBytes() }
                val model = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply { put(bytes); rewind() }
                val gpu = GpuDelegate(compatibility.bestOptionsForThisDevice)
                delegate = gpu
                interpreter = Interpreter(model, Interpreter.Options().addDelegate(gpu))
                embed(Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888))  // warm-up / shader compile
                backend = "gpu"
                available = true
            }
        } catch (t: Throwable) {
            reason = t.message ?: t.javaClass.simpleName
            close()
            interpreter = null
            delegate = null
            backend = "none"
            available = false
        }
    }

    @Synchronized
    fun embed(bitmap: Bitmap): FloatArray {
        val runner = interpreter ?: error("Embedder unavailable: ${reason ?: "not initialized"}")
        // The catalog was built by stretching the card crop to 448×448.
        val scaled = if (bitmap.width == SIZE && bitmap.height == SIZE) bitmap
        else Bitmap.createScaledBitmap(bitmap, SIZE, SIZE, true)
        scaled.getPixels(pixels, 0, SIZE, 0, 0, SIZE, SIZE)
        input.rewind()
        for (c in pixels) {
            input.putFloat(((c ushr 16) and 0xFF).toFloat())
            input.putFloat(((c ushr 8) and 0xFF).toFloat())
            input.putFloat((c and 0xFF).toFloat())
        }
        input.rewind()
        runner.run(input, output)
        return l2Normalize(output[0])
    }

    override fun close() {
        interpreter?.close()
        delegate?.close()
    }

    companion object {
        const val MODEL = "models/milo_cnn_fp16.tflite"
        const val SIZE = 448
        const val DIM = 128
    }
}
