package com.pokoin.cardrails.state

import com.pokoin.cardrails.api.Account
import com.pokoin.cardrails.api.InventoryItem
import com.pokoin.cardrails.api.ScanSettings
import com.pokoin.cardrails.api.apiJson
import kotlinx.serialization.Serializable
import java.io.File

/** One line of the scan tray. The crop JPEG lives in `crops/<id>.jpg` until committed. */
@Serializable
data class TrayLine(
    val id: String,
    val publicId: String,
    val name: String,
    val set: String = "",
    val number: String = "",
    val art: String = "",
    val game: String,
    val language: String,
    val condition: String,
    val printing: String,
    val quantity: Int = 1,
    val score: Float = 0f,
)

@Serializable
data class CachedState(
    val account: Account? = null,
    val settings: ScanSettings = ScanSettings.Default,
    val items: List<InventoryItem> = emptyList(),
    val game: String = "pokemon",
    val language: String = "EN",
    val condition: String = "NM",
    val printing: String = "Standard",
)

@Serializable
data class PersistedTray(val lines: List<TrayLine> = emptyList(), val idempotencyKey: String? = null)

/** Same-card merge rule as iOS: identical card + language + condition + finish add up. */
fun mergeIntoTray(tray: List<TrayLine>, line: TrayLine, mergeRepeats: Boolean): List<TrayLine> {
    val same = tray.indexOfFirst {
        it.publicId == line.publicId && it.language == line.language &&
            it.condition == line.condition && it.printing == line.printing
    }
    if (!mergeRepeats || same < 0) return listOf(line) + tray
    return tray.toMutableList().also { it[same] = it[same].copy(quantity = it[same].quantity + line.quantity) }
}

/** Launch snapshot + scan tray in app storage, written atomically. */
class Persistence(private val root: File) {
    private val stateFile = File(root, "state.json")
    private val trayFile = File(root, "tray.json")
    val cropsDir = File(root, "crops")

    fun loadState(): CachedState? = read(stateFile)?.let { runCatching { apiJson.decodeFromString<CachedState>(it) }.getOrNull() }

    fun loadTray(): PersistedTray? = read(trayFile)?.let { runCatching { apiJson.decodeFromString<PersistedTray>(it) }.getOrNull() }

    @Synchronized
    fun saveState(state: CachedState) = write(stateFile, apiJson.encodeToString(CachedState.serializer(), state))

    @Synchronized
    fun saveTray(tray: PersistedTray) {
        write(trayFile, apiJson.encodeToString(PersistedTray.serializer(), tray))
        val keep = tray.lines.map { "${it.id}.jpg" }.toSet()
        cropsDir.listFiles()?.filter { it.name !in keep }?.forEach { it.delete() }
    }

    fun cropFile(lineId: String) = File(cropsDir, "$lineId.jpg")

    @Synchronized
    fun clear() {
        stateFile.delete()
        trayFile.delete()
        cropsDir.deleteRecursively()
    }

    private fun read(file: File): String? = file.takeIf(File::isFile)?.readText()

    private fun write(file: File, text: String) {
        root.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }
}
