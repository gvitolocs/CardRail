package com.pokoin.cardrails.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

sealed class APIError(message: String) : Exception(message) {
    class Server(val status: Int, val detail: String) : APIError(detail)
    class Transport(message: String) : APIError(message)
}

val apiJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

/**
 * Card Rails API (`cardrails-api.pokoin.com`), same contract as the iPhone app.
 * A 401 clears the token and calls [onUnauthorized]; nothing else signs out.
 */
class APIClient(
    private val tokenStore: TokenStore,
    private val base: String = BASE,
    private val http: OkHttpClient = defaultHttp(),
    private val onUnauthorized: () -> Unit = {},
) {
    suspend fun login(email: String, password: String): AuthResponse =
        send("POST", "/v1/auth/login", Credentials(email, password), Credentials.serializer(), AuthResponse.serializer())
            .also { tokenStore.save(it.token) }

    suspend fun signup(email: String, password: String): AuthResponse =
        send("POST", "/v1/auth/signup", Credentials(email, password), Credentials.serializer(), AuthResponse.serializer())
            .also { tokenStore.save(it.token) }

    suspend fun me(): Account = get("/v1/auth/me", MeResponse.serializer()).account

    suspend fun logout() {
        runCatching { send("POST", "/v1/auth/logout", null, null, OkResponse.serializer()) }
        tokenStore.clear()
    }

    suspend fun inventory(): InventoryResponse = get("/v1/inventory", InventoryResponse.serializer())

    suspend fun updateSettings(update: ScanSettingsUpdate): SettingsResponse =
        send("PUT", "/v1/inventory/settings", update, ScanSettingsUpdate.serializer(), SettingsResponse.serializer())

    /** The API takes the raw JPEG as the body, not a multipart form. */
    suspend fun uploadPhoto(jpeg: ByteArray): PhotoResponse =
        raw("POST", "/v1/photos", jpeg.toRequestBody("image/jpeg".toMediaType()), PhotoResponse.serializer())

    suspend fun commit(commit: ScanCommit): CommitResponse =
        send("POST", "/v1/inventory/scans", commit, ScanCommit.serializer(), CommitResponse.serializer())

    suspend fun patchItem(id: String, patch: ItemPatch): ItemResponse =
        send("PATCH", "/v1/inventory/items/$id", patch, ItemPatch.serializer(), ItemResponse.serializer())

    suspend fun deleteItem(id: String, version: Int): OkResponse =
        raw("DELETE", "/v1/inventory/items/$id?version=$version", null, OkResponse.serializer())

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T = raw("GET", path, null, serializer)

    private suspend fun <B, T> send(
        method: String,
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        responseSerializer: KSerializer<T>,
    ): T {
        val encoded = if (body != null && bodySerializer != null) apiJson.encodeToString(bodySerializer, body) else "{}"
        return raw(method, path, encoded.toRequestBody("application/json".toMediaType()), responseSerializer)
    }

    private suspend fun <T> raw(method: String, path: String, body: RequestBody?, serializer: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(base + path)
                .method(method, body)
                .header("User-Agent", USER_AGENT)
                .apply { tokenStore.load()?.let { header("Authorization", "Bearer $it") } }
                .build()
            val response = try {
                http.newCall(request).execute()
            } catch (e: Exception) {
                throw APIError.Transport(e.message ?: "Connessione assente")
            }
            response.use {
                val text = it.body?.string().orEmpty()
                if (it.code == 401) {
                    tokenStore.clear()
                    onUnauthorized()
                }
                if (!it.isSuccessful) throw APIError.Server(it.code, errorMessage(text))
                apiJson.decodeFromString(serializer, text)
            }
        }

    companion object {
        const val BASE = "https://cardrails-api.pokoin.com"
        const val USER_AGENT = "CardRails-Android/1.0"

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()

        fun errorMessage(text: String): String =
            runCatching { apiJson.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
                ?: "Richiesta non riuscita"
    }
}
