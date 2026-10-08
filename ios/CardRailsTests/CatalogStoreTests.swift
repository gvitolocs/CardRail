import CryptoKit
import XCTest
@testable import CardRails

final class CatalogStoreTests: XCTestCase {
    private let baseURL = URL(string: "https://catalogs.test")!

    private struct Fixture {
        let entry: CatalogEntry
        let indexData: Data
        let embeddings: Data
        let cards: Data
    }

    private func makeFixture(count: Int = 4) throws -> Fixture {
        let embeddings = Data((0..<(count * 128 * 2)).map { UInt8($0 % 251) })
        let cards = Data(#"{"fields":["id","name","number","set","image"],"rows":[["card-1","Pikachu","1","Base","https://img/1.png"]]}"#.utf8)
        let entry = CatalogEntry(
            id: "testcat",
            game: "pokemon",
            languages: ["EN"],
            count: count,
            embeddings: CatalogFile(
                path: "testcat/embeddings-aaa.f16",
                bytes: embeddings.count,
                sha256: sha256(embeddings)
            ),
            cards: CatalogFile(
                path: "testcat/cards-bbb.json",
                bytes: cards.count,
                sha256: sha256(cards)
            )
        )
        let index = CatalogIndex(version: 1, model: nil, catalogs: [entry])
        let indexData = try JSONEncoder().encode(index)
        return Fixture(entry: entry, indexData: indexData, embeddings: embeddings, cards: cards)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func tempRoot() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("cardrails-catalog-\(UUID().uuidString)", isDirectory: true)
    }

    private func installHandler(_ fixture: Fixture, embeddings: Data? = nil) {
        let storedEmbeddings = embeddings ?? fixture.embeddings
        TestURLProtocol.handler = { request in
            let name = request.url?.lastPathComponent ?? ""
            if name == "index.json" { return (200, fixture.indexData) }
            if name == (fixture.entry.embeddings.path as NSString).lastPathComponent {
                return (200, storedEmbeddings)
            }
            if name == (fixture.entry.cards.path as NSString).lastPathComponent {
                return (200, fixture.cards)
            }
            return (404, Data())
        }
    }

    func testRefreshDownloadAndCache() async throws {
        TestURLProtocol.reset()
        let fixture = try makeFixture()
        installHandler(fixture)
        let root = tempRoot()
        let store = CatalogStore(apiBase: baseURL, root: root, session: makeStubSession())

        let index = try await store.refreshIndex()
        XCTAssertEqual(index.catalogs.count, 1)

        try await store.download(fixture.entry, progress: { _ in })
        let downloaded = await store.isDownloaded(fixture.entry)
        XCTAssertTrue(downloaded)
        XCTAssertEqual(TestURLProtocol.requestCount, 3)

        try await store.download(fixture.entry, progress: { _ in })
        XCTAssertEqual(TestURLProtocol.requestCount, 3)

        let loaded = try await store.load(fixture.entry)
        XCTAssertEqual(loaded.records.count, 1)
        XCTAssertEqual(loaded.records.first?.id, "card-1")
        XCTAssertEqual(loaded.records.first?.name, "Pikachu")
    }

    func testCorruptedFileThrowsAndRemoves() async throws {
        TestURLProtocol.reset()
        let fixture = try makeFixture()
        var tampered = fixture.embeddings
        tampered[0] = tampered[0] &+ 1
        installHandler(fixture, embeddings: tampered)
        let root = tempRoot()
        let store = CatalogStore(apiBase: baseURL, root: root, session: makeStubSession())

        do {
            try await store.download(fixture.entry, progress: { _ in })
            XCTFail("expected checksumMismatch")
        } catch {
            XCTAssertEqual(error as? CatalogError, .checksumMismatch)
        }
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent(fixture.entry.embeddings.path).path
            )
        )
    }

    func testOfflineRefreshUsesCachedIndex() async throws {
        TestURLProtocol.reset()
        let fixture = try makeFixture()
        let root = tempRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try fixture.indexData.write(to: root.appendingPathComponent("index.json"))

        TestURLProtocol.handler = { _ in (500, Data()) }
        let store = CatalogStore(apiBase: baseURL, root: root, session: makeStubSession())
        let index = try await store.refreshIndex()
        XCTAssertEqual(index.catalogs.first?.id, "testcat")
    }
}
