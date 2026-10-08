package com.pokoin.cardrails.engine

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

@Serializable
data class CatalogFile(val path: String, val bytes: Long, val sha256: String)

@Serializable
data class CatalogEntry(
    val id: String,
    val game: String,
    val languages: List<String>,
    val count: Int,
    val embeddings: CatalogFile,
    val cards: CatalogFile,
)

@Serializable
data class CatalogIndex(val version: Int, val catalogs: List<CatalogEntry>) {
    /** Same rule as iOS: the game's catalog listing the language (or `*`), else its first one. */
    fun catalogFor(game: String, language: String): CatalogEntry? {
        val forGame = catalogs.filter { it.game == game }
        return forGame.firstOrNull { language in it.languages }
            ?: forGame.firstOrNull { "*" in it.languages }
            ?: forGame.firstOrNull()
    }

    /** Languages the user can pick for a game; `*` means every language. */
    fun languagesFor(game: String): List<String> {
        val entries = catalogs.filter { it.game == game }
        if (entries.isEmpty() || entries.any { "*" in it.languages }) return Languages.all
        val valid = entries.flatMap { it.languages }.toSet()
        return Languages.all.filter { it in valid }.ifEmpty { Languages.all }
    }
}

data class CardRecord(
    val id: String,
    val name: String,
    val number: String?,
    val set: String?,
    val imageUrl: String?,
)

class LoadedCatalog(val entry: CatalogEntry, val index: VectorIndex, val records: List<CardRecord>)

class ChecksumMismatch(path: String) : Exception("Checksum mismatch for $path")

internal val catalogJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

/** Parse `cards-*.json`: {"fields":[...],"rows":[[id,name,number,set,image],...]}. */
fun parseCards(text: String): List<CardRecord> {
    val root = catalogJson.parseToJsonElement(text).jsonObject
    val fields = root["fields"]!!.jsonArray.map { (it as JsonPrimitive).content }
    val idx = { name: String -> fields.indexOf(name) }
    val iId = idx("id"); val iName = idx("name"); val iNumber = idx("number")
    val iSet = idx("set"); val iImage = idx("image")
    fun JsonArray.str(i: Int): String? =
        if (i < 0 || i >= size || this[i] is JsonNull) null else (this[i] as JsonPrimitive).contentOrNull
    return root["rows"]!!.jsonArray.map { element ->
        val row = element.jsonArray
        CardRecord(row.str(iId) ?: "", row.str(iName) ?: "", row.str(iNumber), row.str(iSet), row.str(iImage))
    }
}

/** On-demand catalog files under [root]; one catalog kept loaded in memory. */
class CatalogStore(
    private val apiBase: String,
    private val root: File,
    private val http: OkHttpClient,
) {
    private var loaded: LoadedCatalog? = null
    private val indexFile get() = File(root, "index.json")

    suspend fun refreshIndex(): CatalogIndex = withContext(Dispatchers.IO) {
        try {
            val text = get("v1/catalogs/index.json").decodeToString()
            val index = catalogJson.decodeFromString<CatalogIndex>(text)
            root.mkdirs()
            indexFile.writeText(text)
            index
        } catch (e: Exception) {
            // Offline: fall back to the last index we saw.
            if (indexFile.isFile) catalogJson.decodeFromString(indexFile.readText()) else throw e
        }
    }

    fun isDownloaded(entry: CatalogEntry): Boolean =
        listOf(entry.embeddings, entry.cards).all { File(root, it.path).let { f -> f.isFile && f.length() == it.bytes } }

    suspend fun download(entry: CatalogEntry, progress: (Float) -> Unit = {}) = withContext(Dispatchers.IO) {
        val files = listOf(entry.embeddings, entry.cards)
        val total = files.sumOf { it.bytes }.coerceAtLeast(1)
        var done = 0L
        for (file in files) {
            val dest = File(root, file.path)
            if (dest.isFile && dest.length() == file.bytes) {
                done += file.bytes
                progress(done.toFloat() / total)
                continue
            }
            dest.parentFile?.mkdirs()
            val tmp = File(dest.path + ".part")
            val digest = MessageDigest.getInstance("SHA-256")
            http.newCall(request("v1/catalogs/${file.path}")).execute().use { response ->
                if (!response.isSuccessful) error("HTTP ${response.code} for ${file.path}")
                response.body!!.byteStream().use { input ->
                    tmp.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            output.write(buffer, 0, n)
                            digest.update(buffer, 0, n)
                            done += n
                            progress((done.toFloat() / total).coerceAtMost(1f))
                        }
                    }
                }
            }
            val hex = digest.digest().joinToString("") { "%02x".format(it) }
            if (hex != file.sha256) {
                tmp.delete()
                throw ChecksumMismatch(file.path)
            }
            if (!tmp.renameTo(dest)) error("Could not store ${file.path}")
            // Drop older versions of this catalog's files.
            dest.parentFile?.listFiles()?.forEach {
                val sameKind = it.name.substringBefore('-') == dest.name.substringBefore('-')
                if (sameKind && it.name != dest.name && !it.name.endsWith(".part")) it.delete()
            }
        }
    }

    suspend fun load(entry: CatalogEntry): LoadedCatalog = withContext(Dispatchers.Default) {
        loaded?.takeIf { it.entry.id == entry.id && it.entry.embeddings.sha256 == entry.embeddings.sha256 }
            ?.let { return@withContext it }
        loaded = null  // free the previous catalog before decoding the next one
        val index = VectorIndex.fromF16(File(root, entry.embeddings.path).readBytes(), entry.count)
        val records = parseCards(File(root, entry.cards.path).readText())
        require(records.size == entry.count) { "cards file has ${records.size} rows, expected ${entry.count}" }
        LoadedCatalog(entry, index, records).also { loaded = it }
    }

    fun delete(entry: CatalogEntry) {
        File(root, entry.embeddings.path).parentFile?.deleteRecursively()
        if (loaded?.entry?.id == entry.id) loaded = null
    }

    fun sizeOnDisk(entry: CatalogEntry): Long =
        listOf(entry.embeddings, entry.cards).sumOf { File(root, it.path).takeIf(File::isFile)?.length() ?: 0L }

    private fun request(path: String) = Request.Builder()
        .url(apiBase.trimEnd('/') + "/" + path)
        .header("User-Agent", USER_AGENT)
        .build()

    private fun get(path: String): ByteArray =
        http.newCall(request(path)).execute().use { response ->
            if (!response.isSuccessful) error("HTTP ${response.code} for $path")
            response.body!!.bytes()
        }

    companion object {
        const val USER_AGENT = "CardRails-Android/1.0"
    }
}
