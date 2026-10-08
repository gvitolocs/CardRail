import Combine
import CoreGraphics
import Foundation
import Network
import UIKit
import os

/// Which catalog is currently available to the scanner.
enum CatalogState: Equatable {
    case idle
    case downloading(Double)
    case loading
    case ready(CatalogEntry)
    case failed(String)

    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

/// Root application state: auth, inventory, catalog download and scan commits.
@MainActor
final class AppModel: ObservableObject {
    let api: APIClient
    let scanSession = ScanSession()

    @Published var account: Account?
    @Published var isSignedIn = false
    @Published var scanSettings: ScanSettings?
    @Published var items: [InventoryItem] = []
    @Published var catalogIndex: CatalogIndex?
    @Published var catalogState: CatalogState = .idle
    @Published var game = "pokemon"
    @Published var language = "EN"
    @Published var condition = "NM"
    @Published var printing = "Standard"
    @Published var intent = "sale"
    @Published var toast: String?
    @Published var isCommitting = false
    @Published var needsStorageSetup = false
    @Published var lastRecognitionMs: Double = 0
    @Published var isOffline = false
    @Published var acceptedFlash = 0
    @Published private(set) var recognizer: Recognizer?

    private let tokenStore: TokenStoring
    private let catalogStore: CatalogStore
    private let persistence: PersistenceStore
    private let defaults: UserDefaults
    private var catalogTask: Task<Void, Never>?
    private var pendingIdempotencyKey: String?
    private var commitFailedOffline = false
    private var lastInventoryRefresh: Date?
    private var signOutObserver: NSObjectProtocol?
    private var subscriptions = Set<AnyCancellable>()
    private let pathMonitor = NWPathMonitor()
    private var didLaunch = false
    private let logger = Logger(subsystem: "com.pokoin.cardrails", category: "app")

    static let installedFlag = "cardrails.installed"

    private static let photoConcurrency = 4

    init(
        api: APIClient? = nil,
        tokenStore: TokenStoring = KeychainTokenStore(),
        catalogStore: CatalogStore? = nil,
        persistence: PersistenceStore = PersistenceStore(),
        defaults: UserDefaults = .standard
    ) {
        self.tokenStore = tokenStore
        self.api = api ?? APIClient(tokenStore: tokenStore)
        self.catalogStore = catalogStore
            ?? CatalogStore(apiBase: (api ?? APIClient(tokenStore: tokenStore)).baseURL)
        self.persistence = persistence
        self.defaults = defaults
        observeSignOut()
        observePersistence()
        observeNetwork()
    }

    // MARK: - Launch

    func launch() async {
        guard !didLaunch else { return }
        didLaunch = true

        // iOS keeps keychain items across app deletion: a fresh install starts
        // signed out instead of reviving a stale session.
        if !defaults.bool(forKey: Self.installedFlag) {
            tokenStore.clear()
            persistence.clear()
            defaults.set(true, forKey: Self.installedFlag)
        }

        guard tokenStore.load() != nil else { return }

        // Show the signed-in app at once from the last snapshot; the network
        // only refreshes it. Only a 401 (APIClient posts .cardRailsSignedOut)
        // signs the user out — offline, 5xx or a bad payload keep the session.
        restoreCachedState()
        isSignedIn = true

        do {
            account = try await api.me()
        } catch {
            logger.error("session check failed, staying signed in: \(String(describing: error), privacy: .public)")
        }
        guard isSignedIn else { return }
        await loadAfterSignIn()
    }

    private func restoreCachedState() {
        if let state = persistence.loadState() {
            account = state.account
            scanSettings = state.scanSettings
            items = state.items
            game = state.game
            language = state.language
            condition = state.condition
            printing = state.printing
        }
        if let tray = persistence.loadTray() {
            pendingIdempotencyKey = tray.pendingIdempotencyKey
            scanSession.restore(persisted: tray.lines) { [persistence] id in
                guard let data = persistence.loadCrop(id),
                      let image = UIImage(data: data)?.cgImage else { return nil }
                return image
            }
        }
    }

    // MARK: - Persistence

    private func observePersistence() {
        let changes: [AnyPublisher<Void, Never>] = [
            $account.map { _ in () }.eraseToAnyPublisher(),
            $scanSettings.map { _ in () }.eraseToAnyPublisher(),
            $items.map { _ in () }.eraseToAnyPublisher(),
            $game.map { _ in () }.eraseToAnyPublisher(),
            $language.map { _ in () }.eraseToAnyPublisher(),
            $condition.map { _ in () }.eraseToAnyPublisher(),
            $printing.map { _ in () }.eraseToAnyPublisher(),
        ]
        // @Published emits before the property changes: hop to the next main
        // run-loop turn so the snapshot reads the new values.
        Publishers.MergeMany(changes)
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.persistState() }
            .store(in: &subscriptions)
        scanSession.$lines
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.persistTray() }
            .store(in: &subscriptions)
    }

    private func persistState() {
        guard isSignedIn else { return }
        persistence.saveState(PersistedState(
            account: account,
            scanSettings: scanSettings,
            items: items,
            game: game,
            language: language,
            condition: condition,
            printing: printing
        ))
    }

    private func persistTray() {
        guard isSignedIn else { return }
        var crops: [UUID: Data] = [:]
        for line in scanSession.lines {
            if let crop = line.crop, let jpeg = Self.jpegData(crop) { crops[line.id] = jpeg }
        }
        persistence.saveTray(
            PersistedTray(lines: scanSession.persistedLines(), pendingIdempotencyKey: pendingIdempotencyKey),
            crops: crops
        )
    }

    // MARK: - Lifecycle

    private func observeNetwork() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let offline = path.status != .satisfied
            Task { @MainActor in
                guard let self else { return }
                let cameBack = self.isOffline && !offline
                self.isOffline = offline
                if cameBack { await self.becameActive() }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.pokoin.cardrails.network"))
    }

    /// App returned to the foreground (or the network came back): refresh the
    /// inventory at most every 30 s and retry a commit that failed offline.
    func becameActive() async {
        guard isSignedIn else { return }
        if commitFailedOffline, !scanSession.lines.isEmpty {
            await commit()
        }
        if let last = lastInventoryRefresh, Date().timeIntervalSince(last) < 30 { return }
        await refreshInventory()
    }

    private func loadAfterSignIn() async {
        async let inventory: Void = refreshInventory()
        async let index: Void = refreshIndex()
        await createRecognizer()
        _ = await (inventory, index)
        applySelectedSettings()
        selectCatalog()
    }

    private func createRecognizer() async {
        guard recognizer == nil else { return }
        let created = await Task.detached(priority: .userInitiated) { () -> Recognizer? in
            do {
                let embedder = try Embedder()
                embedder.warmUp()
                return Recognizer(embedder: embedder)
            } catch {
                return nil
            }
        }.value
        recognizer = created
    }

    private func applySelectedSettings() {
        guard let settings = scanSettings else { return }
        game = settings.game
        language = settings.language
        condition = settings.condition
        printing = settings.printing
    }

    // MARK: - Auth

    func login(email: String, password: String) async throws {
        let response = try await api.login(email: email, password: password)
        account = response.account
        isSignedIn = true
        await loadAfterSignIn()
    }

    func signup(email: String, password: String) async throws {
        let response = try await api.signup(email: email, password: password)
        account = response.account
        isSignedIn = true
        await loadAfterSignIn()
    }

    func logout() async {
        try? await api.logout()
        resetToSignedOut()
    }

    private func observeSignOut() {
        signOutObserver = NotificationCenter.default.addObserver(
            forName: .cardRailsSignedOut,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.resetToSignedOut() }
        }
    }

    private func resetToSignedOut() {
        tokenStore.clear()
        persistence.clear()
        pendingIdempotencyKey = nil
        commitFailedOffline = false
        isSignedIn = false
        account = nil
        items = []
        scanSession.clear()
        catalogTask?.cancel()
        recognizer = nil
        catalogState = .idle
        didLaunch = false
    }

    // MARK: - Inventory

    func refreshInventory() async {
        do {
            let response = try await api.inventory()
            items = response.items
            scanSettings = response.scanSettings
            lastInventoryRefresh = Date()
        } catch {
            // Offline: keep whatever we already have.
        }
    }

    func updateItem(id: String, patch: ItemPatch) async {
        do {
            let response = try await api.patchItem(id: id, patch: patch)
            if let index = items.firstIndex(where: { $0.id == id }) {
                items[index] = response.item
            }
        } catch let error as APIError {
            if case .server(let status, let message) = error, status == 409 {
                await refreshInventory()
                toast = message
            } else {
                toast = Self.message(for: error)
            }
        } catch {
            toast = Self.genericError
        }
    }

    func deleteItem(_ item: InventoryItem) async {
        do {
            _ = try await api.deleteItem(id: item.id, version: item.version)
            items.removeAll { $0.id == item.id }
        } catch let error as APIError {
            if case .server(let status, let message) = error, status == 409 {
                await refreshInventory()
                toast = message
            } else {
                toast = Self.message(for: error)
            }
        } catch {
            toast = Self.genericError
        }
    }

    func saveStorage(label: String, stackSize: Int?, stack: Int, startPosition: Int) async {
        var update = ScanSettingsUpdate()
        update.storageLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        update.stackSize = stackSize
        update.stack = stack
        update.startPosition = startPosition
        do {
            let response = try await api.updateSettings(update)
            scanSettings = response.scanSettings
            needsStorageSetup = false
        } catch let error as APIError {
            toast = Self.message(for: error)
        } catch {
            toast = Self.genericError
        }
    }

    // MARK: - Selection

    func setGame(_ id: String) {
        guard game != id else { return }
        game = id
        scanSettings?.game = id
        selectCatalog()
    }

    func setLanguage(_ code: String) {
        guard language != code else { return }
        language = code
        scanSettings?.language = code
        selectCatalog()
    }

    func setCondition(_ value: String) {
        condition = value
        scanSettings?.condition = value
    }

    func setPrinting(_ value: String) {
        printing = value
        scanSettings?.printing = value
    }

    func setIntent(_ value: String) {
        intent = value
    }

    /// Languages that have a catalog for the selected game; `*` means all.
    func availableLanguages() -> [String] {
        guard let index = catalogIndex else { return Languages.all }
        let entries = index.catalogs.filter { $0.game == game }
        guard !entries.isEmpty else { return Languages.all }
        if entries.contains(where: { $0.languages.contains("*") }) {
            return Languages.all
        }
        var valid = Set<String>()
        for entry in entries {
            for code in entry.languages where code != "*" { valid.insert(code) }
        }
        let filtered = Languages.all.filter { valid.contains($0) }
        return filtered.isEmpty ? Languages.all : filtered
    }

    // MARK: - Catalog

    func refreshIndex() async {
        do {
            catalogIndex = try await catalogStore.refreshIndex()
        } catch {
            catalogState = .failed("Catalogo non raggiungibile")
        }
    }

    func selectCatalog() {
        catalogTask?.cancel()
        catalogTask = Task { [weak self] in await self?.loadSelectedCatalog() }
    }

    private func loadSelectedCatalog() async {
        guard let index = catalogIndex else { return }
        guard let entry = index.catalog(for: game, language: language) else {
            catalogState = .failed("Nessun catalogo per questo gioco")
            return
        }

        do {
            recognizer?.clearCatalog()
            catalogState = .downloading(0)
            if !(await catalogStore.isDownloaded(entry)) {
                try await catalogStore.download(entry) { [weak self] progress in
                    Task { @MainActor in self?.catalogState = .downloading(progress) }
                }
            }
            try Task.checkCancellation()
            catalogState = .loading
            let loaded = try await catalogStore.load(entry)
            try Task.checkCancellation()
            recognizer?.setCatalog(loaded)
            catalogState = .ready(entry)
        } catch is CancellationError {
            // Superseded by another selection.
        } catch {
            catalogState = .failed("Scarico catalogo fallito")
        }
    }

    func retryCatalog() {
        selectCatalog()
    }

    func catalogDownloaded(_ entry: CatalogEntry) async -> Bool {
        await catalogStore.isDownloaded(entry)
    }

    func downloadCatalog(_ entry: CatalogEntry) async -> Bool {
        do {
            try await catalogStore.download(entry) { _ in }
            return true
        } catch {
            toast = "Download non riuscito"
            return false
        }
    }

    func deleteCatalog(_ entry: CatalogEntry) async {
        await catalogStore.delete(entry)
        if case .ready(let ready) = catalogState, ready.id == entry.id {
            catalogState = .idle
        }
    }

    // MARK: - Scanning

    func handleAccepted(match: Match, crop: CGImage, ms: Double) {
        lastRecognitionMs = ms
        guard let settings = scanSettings else { return }
        let added = scanSession.add(
            record: match.record,
            score: match.score,
            crop: crop,
            settings: settings
        )
        if added {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            acceptedFlash += 1
        }
    }

    func addCandidate(_ match: Match) {
        guard let settings = scanSettings else { return }
        _ = scanSession.add(record: match.record, score: match.score, crop: nil, settings: settings)
    }

    func markFrameEmpty() {
        scanSession.markFrameEmpty()
    }

    // MARK: - Commit

    func commit() async {
        guard !scanSession.lines.isEmpty, !isCommitting else { return }
        isCommitting = true
        defer { isCommitting = false }

        let photoIds = await uploadPhotos()
        let commit = scanSession.payload(
            intent: intent,
            idempotencyKey: currentIdempotencyKey(),
            photoIds: photoIds
        )

        do {
            let response = try await api.commitScans(commit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            items.insert(contentsOf: response.items, at: 0)
            scanSession.clear()
            pendingIdempotencyKey = nil
            commitFailedOffline = false
            persistTray()
            toast = "\(response.items.count) carte aggiunte all'inventario"
        } catch let error as APIError {
            if case .transport = error {
                commitFailedOffline = true
                toast = "Sei offline — le carte restano in coda e partono appena torna la rete"
            } else if case .server(_, let message) = error, message.lowercased().contains("location") {
                needsStorageSetup = true
            } else {
                toast = Self.message(for: error)
            }
        } catch {
            logger.error("commit failed: \(String(describing: error), privacy: .public)")
            toast = Self.genericError
        }
    }

    private func currentIdempotencyKey() -> String {
        if let key = pendingIdempotencyKey { return key }
        let key = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        pendingIdempotencyKey = key
        persistTray()  // a crash mid-commit must retry with this same key
        return key
    }

    /// Upload every line crop as JPEG, at most `photoConcurrency` at a time.
    /// A failed upload simply omits the line's `photoId`.
    private func uploadPhotos() async -> [UUID: String] {
        let pending = scanSession.lines.compactMap { line -> (UUID, Data)? in
            guard let crop = line.crop, let jpeg = Self.jpegData(crop) else { return nil }
            return (line.id, jpeg)
        }
        guard !pending.isEmpty else { return [:] }

        let api = self.api
        var photoIds: [UUID: String] = [:]
        for start in stride(from: 0, to: pending.count, by: Self.photoConcurrency) {
            let chunk = Array(pending[start..<min(start + Self.photoConcurrency, pending.count)])
            await withTaskGroup(of: (UUID, String?).self) { group in
                for (id, jpeg) in chunk {
                    group.addTask {
                        do {
                            let response = try await api.uploadPhoto(jpeg)
                            return (id, response.id)
                        } catch {
                            return (id, nil)
                        }
                    }
                }
                for await (id, photoId) in group {
                    if let photoId { photoIds[id] = photoId }
                }
            }
        }
        return photoIds
    }

    private static func jpegData(_ image: CGImage) -> Data? {
        UIImage(cgImage: image).jpegData(compressionQuality: 0.7)
    }

    static let genericError = "Qualcosa è andato storto. Riprova."

    static func message(for error: APIError) -> String {
        switch error {
        case .server(_, let message): return message
        case .invalidResponse: return genericError
        case .transport: return "Connessione assente. Riprova quando sei online."
        }
    }
}
