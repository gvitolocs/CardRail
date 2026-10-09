package com.pokoin.cardrails.engine

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.sqrt

/** IEEE 754 half (binary16) bits → float. */
fun halfToFloat(bits: Int): Float {
    val h = bits and 0xFFFF
    val sign = (h ushr 15) and 0x1
    val exponent = (h ushr 10) and 0x1F
    val mantissa = h and 0x3FF
    val outBits = when (exponent) {
        0 -> {
            if (mantissa == 0) {
                sign shl 31
            } else {
                // Subnormal half: normalize it.
                var e = -14
                var m = mantissa
                while (m and 0x400 == 0) {
                    m = m shl 1
                    e -= 1
                }
                m = m and 0x3FF
                (sign shl 31) or ((e + 127) shl 23) or (m shl 13)
            }
        }
        0x1F -> (sign shl 31) or (0xFF shl 23) or (mantissa shl 13)
        else -> (sign shl 31) or ((exponent - 15 + 127) shl 23) or (mantissa shl 13)
    }
    return Float.fromBits(outBits)
}

fun l2Normalize(values: FloatArray): FloatArray {
    var sum = 0f
    for (v in values) sum += v * v
    val norm = sqrt(sum)
    if (norm == 0f) return values.copyOf()
    return FloatArray(values.size) { values[it] / norm }
}

/** Row-major count×dim matrix of L2-normalized catalog embeddings; cosine top-k. */
class VectorIndex(val vectors: FloatArray, val count: Int, val dim: Int = 128) {
    init {
        require(vectors.size == count * dim) { "expected ${count * dim} floats, got ${vectors.size}" }
    }

    data class Hit(val index: Int, val score: Float)

    fun search(query: FloatArray, k: Int): List<Hit> {
        if (count == 0 || k <= 0) return emptyList()
        require(query.size == dim) { "query has ${query.size} dims, index has $dim" }
        val q = l2Normalize(query)
        val keep = minOf(k, count)
        val topIndex = IntArray(keep) { -1 }
        val topScore = FloatArray(keep) { Float.NEGATIVE_INFINITY }
        var row = 0
        while (row < count) {
            var dot = 0f
            val base = row * dim
            var d = 0
            while (d < dim) {
                dot += vectors[base + d] * q[d]
                d++
            }

            if (dot >= topScore[keep - 1]) {
                // Insert into the small sorted buffer.
                var pos = keep - 1
                while (pos > 0 && topScore[pos - 1] < dot) {
                    topScore[pos] = topScore[pos - 1]
                    topIndex[pos] = topIndex[pos - 1]
                    pos--
                }
                topScore[pos] = dot
                topIndex[pos] = row
            }
            row++
        }
        return (0 until keep).filter { topIndex[it] >= 0 }.map { Hit(topIndex[it], topScore[it]) }
    }

    companion object {
        /** Decode little-endian float16 rows (the catalog `.f16` file). */
        fun fromF16(bytes: ByteArray, count: Int, dim: Int = 128): VectorIndex {
            require(bytes.size == count * dim * 2) { "f16 file is ${bytes.size} bytes, expected ${count * dim * 2}" }
            val shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val out = FloatArray(count * dim)
            for (i in out.indices) out[i] = halfToFloat(shorts.get(i).toInt())
            return VectorIndex(out, count, dim)
        }
    }
}
