import Foundation
@testable import CardRails

/// Deterministic URLProtocol stub for API and catalog-store tests.
final class TestURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var requestCount = 0

    static func reset() {
        handler = nil
        requestCount = 0
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        TestURLProtocol.requestCount += 1
        guard let handler = TestURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func makeStubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [TestURLProtocol.self]
    return URLSession(configuration: configuration)
}

final class FakeTokenStore: TokenStoring {
    var token: String?
    func save(_ token: String) { self.token = token }
    func load() -> String? { token }
    func clear() { token = nil }
}

func makeTempPersistence() -> PersistenceStore {
    PersistenceStore(root: FileManager.default.temporaryDirectory
        .appendingPathComponent("cardrails-tests-\(UUID().uuidString)", isDirectory: true))
}

/// Defaults where the app already counts as installed (no fresh-install wipe).
func makeInstalledDefaults() -> UserDefaults {
    let defaults = UserDefaults(suiteName: "cardrails-tests-\(UUID().uuidString)")!
    defaults.set(true, forKey: AppModel.installedFlag)
    return defaults
}

func apiFixture(_ name: String) throws -> Data {
    let bundle = Bundle(for: TestURLProtocol.self)
    guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "api")
        ?? bundle.url(forResource: name, withExtension: "json") else {
        throw NSError(domain: "fixtures", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing fixture api/\(name).json"])
    }
    return try Data(contentsOf: url)
}
