import Foundation

/// Launch state persisted to disk: the account, inventory and the selected
/// catalog options. Written after sign-in so the next launch can render
/// instantly and offline.
struct PersistedState: Codable, Equatable {
    var account: Account?
    var scanSettings: ScanSettings?
    var items: [InventoryItem]
    var game: String
    var language: String
    var condition: String
    var printing: String

    static let empty = PersistedState(
        account: nil,
        scanSettings: nil,
        items: [],
        game: "pokemon",
        language: "EN",
        condition: "NM",
        printing: "Standard"
    )
}

/// The scan tray as stored on disk, plus an in-flight commit's idempotency key.
struct PersistedTray: Codable, Equatable {
    var lines: [PersistedScanLine]
    var pendingIdempotencyKey: String?

    static let empty = PersistedTray(lines: [], pendingIdempotencyKey: nil)
}

/// Application Support persistence for the launch snapshot and the scan tray.
/// Loads are synchronous (they run before any network call at launch); writes
/// are atomic and run on a private background queue after a short debounce.
final class PersistenceStore {
    let root: URL

    private let queue = DispatchQueue(label: "com.pokoin.cardrails.persistence", qos: .utility)
    private let lock = NSLock()
    private var pendingStateWork: DispatchWorkItem?
    private var pendingTrayWork: DispatchWorkItem?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(root: URL? = nil) {
        if let root = root {
            self.root = root
        } else {
            let base = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0]
            self.root = base.appendingPathComponent("CardRails", isDirectory: true)
        }
    }

    private var stateURL: URL { root.appendingPathComponent("state.json") }
    private var trayURL: URL { root.appendingPathComponent("tray.json") }
    private var cropsDirectory: URL { root.appendingPathComponent("crops", isDirectory: true) }
    private func cropURL(_ id: UUID) -> URL {
        cropsDirectory.appendingPathComponent("\(id.uuidString).jpg")
    }

    // MARK: - Synchronous load

    func loadState() -> PersistedState? {
        decode(PersistedState.self, from: stateURL)
    }

    func loadTray() -> PersistedTray? {
        decode(PersistedTray.self, from: trayURL)
    }

    func loadCrop(_ id: UUID) -> Data? {
        try? Data(contentsOf: cropURL(id))
    }

    // MARK: - Debounced asynchronous save

    func saveState(_ state: PersistedState, debounce: TimeInterval = 0.4) {
        schedule(\.pendingStateWork, debounce: debounce) { [weak self] in
            self?.writeState(state)
        }
    }

    func saveTray(_ tray: PersistedTray, crops: [UUID: Data], debounce: TimeInterval = 0.4) {
        schedule(\.pendingTrayWork, debounce: debounce) { [weak self] in
            self?.writeTray(tray, crops: crops)
        }
    }

    /// Wait for queued writes to finish (tests and logout).
    func flush() {
        queue.sync {}
    }

    func clear() {
        lock.lock()
        pendingStateWork?.cancel()
        pendingTrayWork?.cancel()
        pendingStateWork = nil
        pendingTrayWork = nil
        lock.unlock()
        queue.sync {
            let fileManager = FileManager.default
            try? fileManager.removeItem(at: stateURL)
            try? fileManager.removeItem(at: trayURL)
            try? fileManager.removeItem(at: cropsDirectory)
        }
    }

    // MARK: - Private

    private func schedule(
        _ keyPath: ReferenceWritableKeyPath<PersistenceStore, DispatchWorkItem?>,
        debounce: TimeInterval,
        _ work: @escaping () -> Void
    ) {
        let item = DispatchWorkItem(block: work)
        lock.lock()
        self[keyPath: keyPath]?.cancel()
        self[keyPath: keyPath] = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + debounce, execute: item)
    }

    private func decode<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(type, from: data)
    }

    private func writeState(_ state: PersistedState) {
        guard let data = try? encoder.encode(state) else { return }
        write(data, to: stateURL)
    }

    private func writeTray(_ tray: PersistedTray, crops: [UUID: Data]) {
        let fileManager = FileManager.default
        try? fileManager.createDirectory(at: cropsDirectory, withIntermediateDirectories: true)
        for (id, data) in crops {
            write(data, to: cropURL(id))
        }
        let keep = Set(crops.keys.map { "\($0.uuidString).jpg" })
        if let names = try? fileManager.contentsOfDirectory(atPath: cropsDirectory.path) {
            for name in names where !keep.contains(name) {
                try? fileManager.removeItem(at: cropsDirectory.appendingPathComponent(name))
            }
        }
        guard let data = try? encoder.encode(tray) else { return }
        write(data, to: trayURL)
    }

    private func write(_ data: Data, to url: URL) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url, options: .atomic)
    }
}
