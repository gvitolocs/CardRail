package com.pokoin.cardrails.state

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.pokoin.cardrails.api.APIClient
import com.pokoin.cardrails.api.APIError
import com.pokoin.cardrails.api.Account
import com.pokoin.cardrails.api.InventoryItem
import com.pokoin.cardrails.api.ItemPatch
import com.pokoin.cardrails.api.ScanCard
import com.pokoin.cardrails.api.ScanCommit
import com.pokoin.cardrails.api.ScanIdentity
import com.pokoin.cardrails.api.ScanSettings
import com.pokoin.cardrails.api.ScanSettingsUpdate
import com.pokoin.cardrails.api.TokenStore
import com.pokoin.cardrails.camera.ScanPath
import com.pokoin.cardrails.camera.ScanResult
import com.pokoin.cardrails.engine.CatalogEntry
import com.pokoin.cardrails.engine.CatalogIndex
import com.pokoin.cardrails.engine.CatalogStore
import com.pokoin.cardrails.engine.Embedder
import com.pokoin.cardrails.engine.Match
import com.pokoin.cardrails.engine.Recognizer
import com.pokoin.cardrails.engine.ServerScanClient
import com.pokoin.cardrails.engine.Verdict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

sealed class CatalogStatus {
    data object Idle : CatalogStatus()
    data class Downloading(val progress: Float) : CatalogStatus()
    data object Loading : CatalogStatus()
    /** Cards are identified on the phone's GPU against [entry]. */
    data class OnDevice(val entry: CatalogEntry) : CatalogStatus()
    /** No GPU path: cards go to the nezopt GPU worker with catalog [entry]. */
    data class Server(val entry: CatalogEntry, val reason: String) : CatalogStatus()
    data class Failed(val message: String) : CatalogStatus()
}

class AppModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("cardrails", Context.MODE_PRIVATE)
    private val tokenStore = TokenStore(app)
    private val http = APIClient.defaultHttp()
    private val api = APIClient(tokenStore, http = http) { viewModelScope.launch(Dispatchers.Main) { resetSignedOut() } }
    private val persistence = Persistence(File(app.filesDir, "state"))
    private val catalogStore = CatalogStore(APIClient.BASE, File(app.filesDir, "catalogs"), http)
    val server = ServerScanClient(http = http)

    private val _account = MutableStateFlow<Account?>(null); val account: StateFlow<Account?> = _account.asStateFlow()
    private val _signedIn = MutableStateFlow(false); val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()
    private val _items = MutableStateFlow<List<InventoryItem>>(emptyList()); val items: StateFlow<List<InventoryItem>> = _items.asStateFlow()
    private val _settings = MutableStateFlow(ScanSettings.Default); val settings: StateFlow<ScanSettings> = _settings.asStateFlow()
    private val _tray = MutableStateFlow<List<TrayLine>>(emptyList()); val tray: StateFlow<List<TrayLine>> = _tray.asStateFlow()
    private val _message = MutableStateFlow<String?>(null); val message: StateFlow<String?> = _message.asStateFlow()
    private val _offline = MutableStateFlow(false); val offline: StateFlow<Boolean> = _offline.asStateFlow()
    private val _committing = MutableStateFlow(false); val committing: StateFlow<Boolean> = _committing.asStateFlow()
    private val _needsStorage = MutableStateFlow(false); val needsStorage: StateFlow<Boolean> = _needsStorage.asStateFlow()
    private val _catalogIndex = MutableStateFlow<CatalogIndex?>(null); val catalogIndex: StateFlow<CatalogIndex?> = _catalogIndex.asStateFlow()
    private val _catalogStatus = MutableStateFlow<CatalogStatus>(CatalogStatus.Idle); val catalogStatus: StateFlow<CatalogStatus> = _catalogStatus.asStateFlow()
    private val _lastScan = MutableStateFlow<String?>(null); val lastScan: StateFlow<String?> = _lastScan.asStateFlow()
    private val _candidates = MutableStateFlow<List<Match>?>(null); val candidates: StateFlow<List<Match>?> = _candidates.asStateFlow()
    private val _accepted = MutableSharedFlow<Unit>(extraBufferCapacity = 4); val accepted: SharedFlow<Unit> = _accepted

    val game = MutableStateFlow("pokemon")
    val language = MutableStateFlow("EN")
    val condition = MutableStateFlow("NM")
    val printing = MutableStateFlow("Standard")
    val intent = MutableStateFlow("sale")

    /** Read by the camera thread. */
    @Volatile var recognizer: Recognizer? = null; private set
    @Volatile private var embedder: Embedder? = null
    private var embedderReady: Job? = null
    private var catalogJob: Job? = null
    private var idempotencyKey: String? = null
    private var commitFailedOffline = false
    private var lastRefresh = 0L
    private var pendingReviewCrop: Bitmap? = null

    val serverCatalogId: String? get() = _catalogIndex.value?.catalogFor(game.value, language.value)?.id

    init {
        restore()
        embedderReady = viewModelScope.launch(Dispatchers.Default) {
            embedder = runCatching { Embedder(app) }.onFailure { Log.w(TAG, "embedder", it) }.getOrNull()
        }
        watchNetwork(app)
        launch()
    }

    // region Launch / auth

    private fun restore() {
        persistence.loadState()?.let {
            _account.value = it.account; _settings.value = it.settings; _items.value = it.items
            game.value = it.game; language.value = it.language; condition.value = it.condition; printing.value = it.printing
        }
        persistence.loadTray()?.let { _tray.value = it.lines; idempotencyKey = it.idempotencyKey }
    }

    private fun launch() {
        // Android keeps no app data after uninstall, but a restored backup could:
        // a fresh install always starts signed out.
        if (!prefs.getBoolean(INSTALLED, false)) {
            tokenStore.clear(); persistence.clear(); prefs.edit().putBoolean(INSTALLED, true).apply()
            _tray.value = emptyList(); _items.value = emptyList(); _account.value = null
        }
        if (tokenStore.load() == null) return
        // Signed in from the cached snapshot at once; only a 401 signs out.
        _signedIn.value = true
        viewModelScope.launch { refreshAll() }
    }

    private suspend fun refreshAll() {
        runCatching { api.me() }.onSuccess { _account.value = it; persistState() }
        refreshInventory()
        runCatching { catalogStore.refreshIndex() }
            .onSuccess { _catalogIndex.value = it }
            .onFailure { if (_catalogIndex.value == null) _catalogStatus.value = CatalogStatus.Failed("Catalogo non raggiungibile") }
        selectCatalog()
    }

    fun authenticate(email: String, password: String, signup: Boolean, done: (String?) -> Unit) {
        viewModelScope.launch {
            runCatching { if (signup) api.signup(email, password) else api.login(email, password) }
                .onSuccess {
                    _account.value = it.account
                    _signedIn.value = true
                    persistState()
                    done(null)
                    refreshAll()
                }
                .onFailure { done(errorText(it)) }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            api.logout()
            resetSignedOut()
        }
    }

    private fun resetSignedOut() {
        tokenStore.clear()
        persistence.clear()
        _signedIn.value = false; _account.value = null; _items.value = emptyList(); _tray.value = emptyList()
        idempotencyKey = null; commitFailedOffline = false
    }

    // endregion
    // region Inventory

    suspend fun refreshInventory() {
        runCatching { api.inventory() }.onSuccess {
            _items.value = it.items
            _settings.value = it.scanSettings
            lastRefresh = System.currentTimeMillis()
            persistState()
        }
    }

    /** App back in the foreground: refresh at most every 30 s, retry an offline commit. */
    fun onResume() {
        if (!_signedIn.value) return
        viewModelScope.launch {
            if (commitFailedOffline && _tray.value.isNotEmpty()) commit()
            if (System.currentTimeMillis() - lastRefresh > 30_000) refreshInventory()
        }
    }

    fun patch(item: InventoryItem, patch: ItemPatch) = viewModelScope.launch {
        runCatching { api.patchItem(item.id, patch) }
            .onSuccess { r -> _items.value = _items.value.map { if (it.id == item.id) r.item else it }; persistState() }
            .onFailure { failure ->
                if (failure is APIError.Server && failure.status == 409) refreshInventory()
                _message.value = errorText(failure)
            }
    }

    fun delete(item: InventoryItem) = viewModelScope.launch {
        runCatching { api.deleteItem(item.id, item.version) }
            .onSuccess { _items.value = _items.value.filterNot { it.id == item.id }; persistState() }
            .onFailure { failure ->
                if (failure is APIError.Server && failure.status == 409) refreshInventory()
                _message.value = errorText(failure)
            }
    }

    fun saveStorage(label: String, stackSize: Int?, stack: Int, startPosition: Int, done: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            runCatching {
                api.updateSettings(ScanSettingsUpdate(storageLabel = label.trim(), stackSize = stackSize, stack = stack, startPosition = startPosition))
            }.onSuccess {
                _settings.value = it.scanSettings
                _needsStorage.value = false
                persistState()
                done(true)
            }.onFailure {
                _message.value = errorText(it)
                done(false)
            }
        }
    }

    fun dismissStorage() { _needsStorage.value = false }
    fun requestStorage() { _needsStorage.value = true }
    fun clearMessage() { _message.value = null }

    // endregion
    // region Catalogs

    fun setGame(id: String) {
        if (game.value == id) return
        game.value = id
        val valid = _catalogIndex.value?.languagesFor(id)
        if (valid != null && language.value !in valid) language.value = valid.first()
        persistState(); selectCatalog()
    }

    fun setLanguage(code: String) { if (language.value != code) { language.value = code; persistState(); selectCatalog() } }
    fun setCondition(value: String) { condition.value = value; persistState() }
    fun setPrinting(value: String) { printing.value = value; persistState() }

    fun selectCatalog() {
        catalogJob?.cancel()
        catalogJob = viewModelScope.launch {
            val index = _catalogIndex.value ?: return@launch
            val entry = index.catalogFor(game.value, language.value)
                ?: run { _catalogStatus.value = CatalogStatus.Failed("Nessun catalogo per questo gioco"); return@launch }
            recognizer = null
            embedderReady?.join()
            val gpu = embedder?.takeIf { it.available }
            if (gpu == null) {
                // No GPU path on this phone: identify on the nezopt server, no download needed.
                _catalogStatus.value = CatalogStatus.Server(entry, embedder?.reason ?: "GPU non disponibile")
                return@launch
            }
            try {
                if (!catalogStore.isDownloaded(entry)) {
                    _catalogStatus.value = CatalogStatus.Downloading(0f)
                    catalogStore.download(entry) { p -> _catalogStatus.value = CatalogStatus.Downloading(p) }
                }
                _catalogStatus.value = CatalogStatus.Loading
                val loaded = catalogStore.load(entry)
                recognizer = Recognizer(gpu, loaded)
                _catalogStatus.value = CatalogStatus.OnDevice(entry)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "catalog ${entry.id}", e)
                // The server still works while the download is unavailable.
                _catalogStatus.value = CatalogStatus.Server(entry, "Download catalogo non riuscito")
            }
        }
    }

    suspend fun isDownloaded(entry: CatalogEntry) = withContext(Dispatchers.IO) { catalogStore.isDownloaded(entry) }
    fun catalogSize(entry: CatalogEntry) = catalogStore.sizeOnDisk(entry)
    fun downloadCatalog(entry: CatalogEntry, done: () -> Unit) = viewModelScope.launch {
        runCatching { catalogStore.download(entry) }.onFailure { _message.value = "Download non riuscito" }
        done()
    }
    fun deleteCatalog(entry: CatalogEntry) {
        if (recognizer?.catalog?.entry?.id == entry.id) recognizer = null
        catalogStore.delete(entry)
        selectCatalog()
    }

    // endregion
    // region Scanning

    fun onScanResult(result: ScanResult) {
        _lastScan.value = when (result.path) {
            ScanPath.GPU -> "GPU · ${result.millis} ms"
            ScanPath.SERVER -> "Server nezopt · ${result.millis} ms"
        }
        when (val verdict = result.verdict) {
            is Verdict.Accepted -> { addToTray(verdict.match, result.crop); _accepted.tryEmit(Unit) }
            is Verdict.Review -> { pendingReviewCrop = result.crop; _candidates.value = verdict.matches.take(3) }
            Verdict.None -> Unit
        }
    }

    val reviewing: Boolean get() = _candidates.value != null

    fun chooseCandidate(match: Match) {
        addToTray(match, pendingReviewCrop)
        dismissCandidates()
    }

    fun dismissCandidates() { _candidates.value = null; pendingReviewCrop = null }

    private fun addToTray(match: Match, crop: Bitmap?) {
        val line = TrayLine(
            id = UUID.randomUUID().toString(),
            publicId = match.record.id,
            name = match.record.name,
            set = match.record.set.orEmpty(),
            number = match.record.number.orEmpty(),
            art = match.record.imageUrl.orEmpty(),
            game = game.value,
            language = language.value,
            condition = condition.value,
            printing = printing.value,
            score = match.score,
        )
        if (crop != null) {
            viewModelScope.launch(Dispatchers.IO) {
                runCatching {
                    persistence.cropsDir.mkdirs()
                    persistence.cropFile(line.id).outputStream().use { crop.compress(Bitmap.CompressFormat.JPEG, 80, it) }
                }
            }
        }
        _tray.value = mergeIntoTray(_tray.value, line, _settings.value.mergeRepeats)
        persistTray()
    }

    fun setQuantity(id: String, quantity: Int) {
        _tray.value = _tray.value.map { if (it.id == id) it.copy(quantity = quantity.coerceIn(1, 10_000)) else it }
        persistTray()
    }

    fun removeFromTray(id: String) { _tray.value = _tray.value.filterNot { it.id == id }; persistTray() }

    // endregion
    // region Commit

    fun commit() {
        if (_tray.value.isEmpty() || _committing.value) return
        if (!_settings.value.locationConfigured) { _needsStorage.value = true; return }
        viewModelScope.launch {
            _committing.value = true
            try {
                val lines = _tray.value
                // One key per batch, kept on disk: a retry after a crash can't duplicate cards.
                val key = idempotencyKey ?: UUID.randomUUID().toString().replace("-", "").also { idempotencyKey = it; persistTray() }
                val photoIds = uploadPhotos(lines)
                val cards = lines.map {
                    ScanCard(
                        identity = ScanIdentity(it.game, it.name, it.set, it.number, it.publicId),
                        art = it.art, language = it.language, condition = it.condition, printing = it.printing,
                        firstEdition = false, signed = false, altered = false, quantity = it.quantity,
                        price = 0.0, photoId = photoIds[it.id],
                    )
                }
                val response = api.commit(ScanCommit(key, intent.value, cards))
                _items.value = response.items + _items.value.filterNot { old -> response.items.any { it.id == old.id } }
                _tray.value = emptyList()
                idempotencyKey = null
                commitFailedOffline = false
                persistTray(); persistState()
                _message.value = "${response.items.size} carte aggiunte all'inventario"
            } catch (e: APIError.Transport) {
                commitFailedOffline = true
                _message.value = "Sei offline — le carte restano in coda e partono appena torna la rete"
            } catch (e: APIError.Server) {
                if (e.detail.contains("location", ignoreCase = true)) _needsStorage.value = true else _message.value = e.detail
            } catch (e: Exception) {
                Log.w(TAG, "commit", e)
                _message.value = GENERIC_ERROR
            } finally {
                _committing.value = false
            }
        }
    }

    private suspend fun uploadPhotos(lines: List<TrayLine>): Map<String, String> {
        val gate = Semaphore(4)
        return lines.map { line ->
            viewModelScope.async(Dispatchers.IO) {
                gate.withPermit {
                    val file = persistence.cropFile(line.id)
                    if (!file.isFile) return@withPermit null
                    runCatching { line.id to api.uploadPhoto(file.readBytes()).id }.getOrNull()
                }
            }
        }.awaitAll().filterNotNull().toMap()
    }

    // endregion
    // region Persistence / network

    private fun persistState() {
        if (!_signedIn.value) return
        val snapshot = CachedState(_account.value, _settings.value, _items.value, game.value, language.value, condition.value, printing.value)
        viewModelScope.launch(Dispatchers.IO) { persistence.saveState(snapshot) }
    }

    private fun persistTray() {
        val snapshot = PersistedTray(_tray.value, idempotencyKey)
        viewModelScope.launch(Dispatchers.IO) { persistence.saveTray(snapshot) }
    }

    private fun watchNetwork(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        _offline.value = cm.activeNetwork == null
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val cameBack = _offline.value
                _offline.value = false
                if (cameBack) onResume()
            }
            override fun onLost(network: Network) { _offline.value = true }
        })
    }

    private fun errorText(error: Throwable): String = when (error) {
        is APIError.Server -> error.detail
        is APIError.Transport -> "Connessione assente. Riprova quando sei online."
        else -> GENERIC_ERROR
    }

    override fun onCleared() {
        embedder?.close()
        super.onCleared()
    }

    companion object {
        private const val TAG = "CardRails"
        private const val INSTALLED = "installed"
        const val GENERIC_ERROR = "Qualcosa è andato storto. Riprova."
    }
}
