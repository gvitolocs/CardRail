import Security
import XCTest
@testable import CardRails

/// Every payload the app decodes, recorded from the live API.
final class APIContractTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: try apiFixture(name))
    }

    func testEveryRecordedResponseDecodes() throws {
        XCTAssertEqual(try decode(AuthResponse.self, "signup").token, "TEST_TOKEN")
        XCTAssertFalse(try decode(AuthResponse.self, "login").account.email.isEmpty)
        XCTAssertTrue(try decode(MeResponse.self, "me").account.email.hasSuffix("@cardrails.test"))
        let inventory = try decode(InventoryResponse.self, "inventory")
        XCTAssertFalse(inventory.items.isEmpty)
        XCTAssertNotNil(inventory.items.first?.location)
        _ = try decode(SettingsResponse.self, "settings_put")
        XCTAssertTrue(try decode(PhotoResponse.self, "photo_post").id.hasPrefix("photo_"))
        XCTAssertFalse(try decode(CommitResponse.self, "scans_post").items.isEmpty)
        _ = try decode(ItemResponse.self, "item_patch")
        _ = try decode(OkResponse.self, "item_delete")
        XCTAssertEqual(try decode(APIErrorMessage.self, "error_401").error, "Email or password is wrong.")
    }
}

@MainActor
final class AppModelLaunchTests: XCTestCase {
    private func makeModel(
        tokens: FakeTokenStore,
        persistence: PersistenceStore = makeTempPersistence(),
        defaults: UserDefaults = makeInstalledDefaults(),
        center: NotificationCenter = .default
    ) -> AppModel {
        let client = APIClient(
            baseURL: URL(string: "https://api.test")!,
            session: makeStubSession(),
            tokenStore: tokens,
            notificationCenter: center
        )
        let catalogs = CatalogStore(
            apiBase: URL(string: "https://api.test")!,
            root: FileManager.default.temporaryDirectory.appendingPathComponent("catalogs-\(UUID().uuidString)"),
            session: makeStubSession()
        )
        return AppModel(
            api: client, tokenStore: tokens, catalogStore: catalogs,
            persistence: persistence, defaults: defaults
        )
    }

    override func tearDown() {
        TestURLProtocol.reset()
        super.tearDown()
    }

    private func launch(meStatus: Int, meBody: String) async -> (AppModel, FakeTokenStore) {
        let tokens = FakeTokenStore()
        tokens.token = "TEST_TOKEN"
        TestURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/v1/auth/me") == true { return (meStatus, Data(meBody.utf8)) }
            return (503, Data(#"{"error":"down"}"#.utf8))
        }
        let model = makeModel(tokens: tokens)
        await model.launch()
        return (model, tokens)
    }

    func testServerErrorKeepsSession() async {
        let (model, tokens) = await launch(meStatus: 500, meBody: #"{"error":"boom"}"#)
        XCTAssertTrue(model.isSignedIn)
        XCTAssertEqual(tokens.token, "TEST_TOKEN")
    }

    func testGarbagePayloadKeepsSession() async {
        let (model, tokens) = await launch(meStatus: 200, meBody: "not json")
        XCTAssertTrue(model.isSignedIn)
        XCTAssertEqual(tokens.token, "TEST_TOKEN")
    }

    func testTransportErrorKeepsSession() async {
        let tokens = FakeTokenStore()
        tokens.token = "TEST_TOKEN"
        TestURLProtocol.handler = nil  // every request fails at the transport level
        let model = makeModel(tokens: tokens)
        await model.launch()
        XCTAssertTrue(model.isSignedIn)
        XCTAssertEqual(tokens.token, "TEST_TOKEN")
    }

    func testValidSessionLoadsAccount() async throws {
        let me = String(data: try apiFixture("me"), encoding: .utf8)!
        let (model, _) = await launch(meStatus: 200, meBody: me)
        XCTAssertTrue(model.isSignedIn)
        XCTAssertNotNil(model.account)
    }

    func testUnauthorizedSignsOut() async {
        let center = NotificationCenter.default
        let tokens = FakeTokenStore()
        tokens.token = "TEST_TOKEN"
        TestURLProtocol.handler = { _ in (401, Data(#"{"error":"Sign in to Card Rails."}"#.utf8)) }
        let model = makeModel(tokens: tokens, center: center)
        await model.launch()
        try? await Task.sleep(nanoseconds: 200_000_000)  // sign-out notification hops to main
        XCTAssertFalse(model.isSignedIn)
        XCTAssertNil(tokens.token)
    }

    func testCachedItemsShowBeforeNetwork() async throws {
        let persistence = makeTempPersistence()
        let inventory = try JSONDecoder().decode(InventoryResponse.self, from: try apiFixture("inventory"))
        var state = PersistedState.empty
        state.items = inventory.items
        state.game = "magic"
        persistence.saveState(state, debounce: 0)
        persistence.flush()

        let tokens = FakeTokenStore()
        tokens.token = "TEST_TOKEN"
        TestURLProtocol.handler = nil  // offline
        let model = makeModel(tokens: tokens, persistence: persistence)
        await model.launch()
        XCTAssertTrue(model.isSignedIn)
        XCTAssertEqual(model.items.count, inventory.items.count)
        XCTAssertEqual(model.game, "magic")
    }

    func testFreshInstallClearsStaleToken() async {
        let tokens = FakeTokenStore()
        tokens.token = "STALE"
        let defaults = UserDefaults(suiteName: "cardrails-tests-\(UUID().uuidString)")!
        let model = makeModel(tokens: tokens, defaults: defaults)
        await model.launch()
        XCTAssertFalse(model.isSignedIn)
        XCTAssertNil(tokens.token)
        XCTAssertTrue(defaults.bool(forKey: AppModel.installedFlag))
    }
}

final class KeychainTokenStoreTests: XCTestCase {
    func testSaveUpdatesAndClears() throws {
        // Simulator test hosts run unsigned (SMB mount), so they have no keychain
        // entitlement (errSecMissingEntitlement); the signed device build does.
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.pokoin.cardrails.probe",
            kSecAttrAccount as String: "probe",
            kSecValueData as String: Data("x".utf8),
        ]
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        try XCTSkipIf(status == errSecMissingEntitlement, "No keychain entitlement in this test host")
        let store = KeychainTokenStore()
        let previous = store.load()
        defer { if let previous { store.save(previous) } else { store.clear() } }
        store.save("first")
        store.save("second")
        XCTAssertEqual(store.load(), "second")
        store.clear()
        XCTAssertNil(store.load())
    }
}

@MainActor
final class PersistenceTests: XCTestCase {
    func testStateAndTrayRoundTrip() throws {
        let persistence = makeTempPersistence()
        var state = PersistedState.empty
        state.language = "JP"
        persistence.saveState(state, debounce: 0)

        let record = CardRecord(id: "p1", name: "Pikachu", number: "58", set: "Base", imageURL: nil)
        let line = PersistedScanLine(
            id: UUID(), record: record, game: "pokemon", language: "EN", condition: "NM",
            printing: "Standard", quantity: 2, score: 0.9, firstEdition: false, signed: false, altered: false
        )
        persistence.saveTray(
            PersistedTray(lines: [line], pendingIdempotencyKey: "key-123"),
            crops: [line.id: Data([0xFF, 0xD8, 0xFF, 0xE0])],
            debounce: 0
        )
        persistence.flush()

        XCTAssertEqual(persistence.loadState()?.language, "JP")
        let tray = try XCTUnwrap(persistence.loadTray())
        XCTAssertEqual(tray.lines, [line])
        XCTAssertEqual(tray.pendingIdempotencyKey, "key-123")
        XCTAssertEqual(persistence.loadCrop(line.id), Data([0xFF, 0xD8, 0xFF, 0xE0]))

        persistence.clear()
        XCTAssertNil(persistence.loadState())
        XCTAssertNil(persistence.loadTray())
    }
}
