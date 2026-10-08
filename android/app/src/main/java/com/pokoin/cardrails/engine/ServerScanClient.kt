package com.pokoin.cardrails.engine

import android.graphics.Bitmap
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.util.concurrent.TimeUnit

@Serializable
private data class IdentifyResponse(val hits: List<HitDto> = emptyList())
@Serializable
private data class HitDto(
    val name: String = "", val set: String? = null, val collector_number: String? = null,
    val public_id: String? = null, val id: String? = null, val ct_id: String? = null,
    val image_url: String? = null, val score: Float = 0f,
)

class ServerScanClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build(),
    private val endpoint: String = "https://api.pokoin.com/api/scan/identify",
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** Map `api.pokoin.com/api/scan/identify` hits like scan-web does. */
        fun parseIdentify(text: String): List<Match> =
            json.decodeFromString<IdentifyResponse>(text).hits.map {
                Match(CardRecord(it.public_id ?: it.id ?: "", it.name, it.collector_number, it.set, it.image_url), it.score)
            }
    }
    fun identify(bitmap: Bitmap, catalogId: String, topK: Int = 5): List<Match> {
        val jpeg = java.io.ByteArrayOutputStream().also {
            val scale = minOf(1f, 640f / maxOf(bitmap.width, bitmap.height))
            val source = if (scale < 1f) Bitmap.createScaledBitmap(bitmap,
                (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
            source.compress(Bitmap.CompressFormat.JPEG, 85, it)
        }.toByteArray()
        val imageBody = object : RequestBody() {
                override fun contentType() = "image/jpeg".toMediaType()
                override fun contentLength() = jpeg.size.toLong()
                override fun writeTo(sink: BufferedSink) { sink.write(jpeg) }
            }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", "card.jpg", imageBody).build()
            val request = Request.Builder().url("$endpoint?catalog=$catalogId&top_k=$topK")
                .post(body).header("User-Agent", CatalogStore.USER_AGENT).build()
        http.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "HTTP ${response.code}" }
                return parseIdentify(response.body!!.string())
        }
    }
}
