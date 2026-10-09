import XCTest
@testable import CardRails

/// The app's dictionary must match `GET /v1/dictionary` (recorded fixture shared
/// with the Android and web tests).
final class CodesTests: XCTestCase {
    private struct Dictionary: Decodable {
        let version: Int
        let games, languages, conditions, printings, flags: [String: String]
    }

    private func table(_ values: [String]) -> [String: String] {
        Swift.Dictionary(uniqueKeysWithValues: values.enumerated().map { ("\($0.offset + 1)", $0.element) })
    }

    func testDictionaryMatchesTheAPI() throws {
        let server = try JSONDecoder().decode(Dictionary.self, from: try apiFixture("dictionary"))
        XCTAssertEqual(server.version, Codes.version)
        XCTAssertEqual(server.games, table(Codes.games))
        XCTAssertEqual(server.languages, table(Codes.languages))
        XCTAssertEqual(server.conditions, table(Codes.conditions))
        XCTAssertEqual(server.printings, table(Codes.printings))
        XCTAssertEqual(server.flags["16"], "imported")
        XCTAssertEqual(Codes.Flags.imported.rawValue, 16)
    }

    func testLookups() {
        XCTAssertEqual(Codes.code("IT", in: Codes.languages), 2)
        XCTAssertEqual(Codes.value(5, in: Codes.languages), "JP")
        XCTAssertNil(Codes.value(0, in: Codes.languages))
        XCTAssertNil(Codes.code("Etched Foil", in: Codes.printings))
    }
}
