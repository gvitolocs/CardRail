import CryptoKit
import Foundation

struct CatalogModel: Codable {
    let name: String
    let onnxSha256: String?
    let dim: Int
    let size: Int
    let dtype: String
}

struct CatalogFile: Codable, Equatable {
    let path: String
    let bytes: Int
    let sha256: String
}

struct CatalogEntry: Codable, Equatable, Identifiable {
    let id: String
    let game: String
    let languages: [String]
    let count: Int
    let embeddings: CatalogFile
    let cards: CatalogFile
}

struct CatalogIndex: Codable {
    let version: Int
    let model: CatalogModel?
    let catalogs: [CatalogEntry]

    /// The entry for a game/language: first matching language (or "*"), else the
    /// first entry of that game (e.g. Pokémon KO falls back to pokemon_western).
    func catalog(for game: String, language: String) -> CatalogEntry? {
        let forGame = catalogs.filter { $0.game == game }
        if let exact = forGame.first(where: { entry in
            entry.languages.contains(language) || entry.languages.contains("*")
        }) {
            return exact
        }
        return forGame.first
    }
}

struct CardRecord: Hashable, Sendable {
    let id: String
    let name: String
    let number: String?
    let set: String?
    let imageURL: URL?
}

struct LoadedCatalog {
    let entry: CatalogEntry
    let index: VectorIndex
    let records: [CardRecord]
}

private struct CatalogCards: Codable {
    let fields: [String]
    let rows: [[String?]]
}

enum CatalogError: Error, Equatable {
    case checksumMismatch
    case badResponse(status: Int)
    case missingFile
    case indexUnavailable
}

/// Downloads and caches on-device recognition catalogs. One catalog is kept
/// loaded in memory; loading a different game/language replaces it.
actor CatalogStore {
    let apiBase: URL
    let root: URL
    private let session: URLSession

    private var loadedID: String?
    private var loadedCatalog: LoadedCatalog?
    private var verified: [String: String] = [:]

    init(apiBase: URL, root: URL? = nil, session: URLSession = .shared) {
        self.apiBase = apiBase
        if let root = root {
            self.root = root
        } else {
            let base = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0]
            self.root = base.appendingPathComponent("catalogs", isDirectory: true)
        }
        self.session = session
        self.verified = Self.loadVerified(at: self.root)
    }

    private var indexPath: URL { root.appendingPathComponent("index.json") }

    private func catalogURL(_ file: CatalogFile) -> URL {
        apiBase
            .appendingPathComponent("v1/catalogs")
            .appendingPathComponent(file.path)
    }

    func refreshIndex() async throws -> CatalogIndex {
        do {
            let (data, response) = try await session.data(from: catalogURL(
                CatalogFile(path: "index.json", bytes: 0, sha256: "")
            ))
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw CatalogError.badResponse(
                    status: (response as? HTTPURLResponse)?.statusCode ?? 0
                )
            }
            let index = try JSONDecoder().decode(CatalogIndex.self, from: data)
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try? data.write(to: indexPath)
            prune(using: index)
            return index
        } catch {
            if
                let cached = try? Data(contentsOf: indexPath),
                let index = try? JSONDecoder().decode(CatalogIndex.self, from: cached)
            {
                return index
            }
            throw error
        }
    }

    func isDownloaded(_ entry: CatalogEntry) -> Bool {
        fileSize(entry.embeddings) == entry.embeddings.bytes
            && fileSize(entry.cards) == entry.cards.bytes
    }

    func download(_ entry: CatalogEntry, progress: @Sendable (Double) -> Void) async throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let total = max(1, entry.embeddings.bytes + entry.cards.bytes)
        var done = 0
        for file in [entry.embeddings, entry.cards] {
            done = try await download(file, done: done, total: total, progress: progress)
        }
    }

    func unload(_ entry: CatalogEntry) {
        if loadedID == entry.id {
            loadedID = nil
            loadedCatalog = nil
        }
    }

    func delete(_ entry: CatalogEntry) {
        let fileManager = FileManager.default
        for file in [entry.embeddings, entry.cards] {
            verified.removeValue(forKey: file.path)
            let url = root.appendingPathComponent(file.path)
            try? fileManager.removeItem(at: url)
        }
        unload(entry)
        Self.saveVerified(verified, at: root)
    }

    func load(_ entry: CatalogEntry) async throws -> LoadedCatalog {
        if let loadedID = loadedID, loadedID == entry.id, let loadedCatalog = loadedCatalog {
            return loadedCatalog
        }
        let embeddingsPath = root.appendingPathComponent(entry.embeddings.path)
        let cardsPath = root.appendingPathComponent(entry.cards.path)
        guard
            let embeddings = try? Data(contentsOf: embeddingsPath),
            let cardsData = try? Data(contentsOf: cardsPath)
        else { throw CatalogError.missingFile }

        let index = try VectorIndex(f16: embeddings, count: entry.count, dim: 128)
        let cards = try JSONDecoder().decode(CatalogCards.self, from: cardsData)
        let records = cards.rows.map { row -> CardRecord in
            let id = row.count > 0 ? (row[0] ?? "") : ""
            let name = row.count > 1 ? (row[1] ?? "") : ""
            let number = row.count > 2 ? row[2] : nil
            let set = row.count > 3 ? row[3] : nil
            let image = row.count > 4 ? row[4] : nil
            return CardRecord(
                id: id,
                name: name,
                number: number,
                set: set,
                imageURL: image.flatMap { URL(string: $0) }
            )
        }
        let catalog = LoadedCatalog(entry: entry, index: index, records: records)
        loadedID = entry.id
        loadedCatalog = catalog
        return catalog
    }

    // MARK: - Private

    private func download(
        _ file: CatalogFile,
        done: Int,
        total: Int,
        progress: @Sendable (Double) -> Void
    ) async throws -> Int {
        let destination = root.appendingPathComponent(file.path)
        if isVerified(destination, file: file) {
            let updated = done + file.bytes
            progress(Double(updated) / Double(total))
            return updated
        }

        let (data, response) = try await session.data(from: catalogURL(file))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CatalogError.badResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }

        let sha = Self.sha256Hex(data)
        guard sha == file.sha256, data.count == file.bytes else {
            try? FileManager.default.removeItem(at: destination)
            throw CatalogError.checksumMismatch
        }

        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let temporary = destination.appendingPathExtension("tmp-\(UUID().uuidString)")
        try data.write(to: temporary)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
        markVerified(file.path, sha: sha)

        let updated = done + data.count
        progress(Double(updated) / Double(total))
        return updated
    }

    private func isVerified(_ url: URL, file: CatalogFile) -> Bool {
        guard fileSize(file) == file.bytes else { return false }
        return verified[file.path] == file.sha256
    }

    private func fileSize(_ file: CatalogFile) -> Int? {
        let url = root.appendingPathComponent(file.path)
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.intValue
    }

    private func markVerified(_ path: String, sha: String) {
        verified[path] = sha
        Self.saveVerified(verified, at: root)
    }

    /// Remove files in a catalog directory that the current index does not reference.
    private func prune(using index: CatalogIndex) {
        let fileManager = FileManager.default
        for entry in index.catalogs {
            let directory = root.appendingPathComponent(
                (entry.embeddings.path as NSString).deletingLastPathComponent,
                isDirectory: true
            )
            let referenced = Set([
                (entry.embeddings.path as NSString).lastPathComponent,
                (entry.cards.path as NSString).lastPathComponent,
            ])
            guard let contents = try? fileManager.contentsOfDirectory(atPath: directory.path) else {
                continue
            }
            for name in contents where !referenced.contains(name) {
                try? fileManager.removeItem(at: directory.appendingPathComponent(name))
            }
        }
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func loadVerified(at root: URL) -> [String: String] {
        let url = root.appendingPathComponent("verified.json")
        guard
            let data = try? Data(contentsOf: url),
            let map = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return map
    }

    private static func saveVerified(_ map: [String: String], at root: URL) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try? data.write(to: root.appendingPathComponent("verified.json"))
    }
}
