import XCTest
@testable import CardRails

@MainActor
final class ScanSessionTests: XCTestCase {
    private let record = CardRecord(
        id: "p1",
        name: "Pikachu",
        number: "58",
        set: "Base",
        imageURL: URL(string: "https://img/p1.png")
    )

    private func settings(
        condition: String = "NM",
        printing: String = "Standard",
        mergeRepeats: Bool = true
    ) -> ScanSettings {
        var settings = ScanSettings.default
        settings.condition = condition
        settings.printing = printing
        settings.mergeRepeats = mergeRepeats
        return settings
    }

    func testRepeatWindowIgnoresSameCard() async throws {
        let session = ScanSession()
        let start = Date()
        let config = settings()

        XCTAssertTrue(session.add(record: record, score: 0.9, crop: nil, settings: config, at: start))
        XCTAssertFalse(
            session.add(
                record: record,
                score: 0.9,
                crop: nil,
                settings: config,
                at: start.addingTimeInterval(0.5)
            )
        )

        session.markFrameEmpty()
        XCTAssertTrue(
            session.add(
                record: record,
                score: 0.9,
                crop: nil,
                settings: config,
                at: start.addingTimeInterval(0.6)
            )
        )

        XCTAssertEqual(session.lines.count, 1)
        XCTAssertEqual(session.lines[0].quantity, 2)
        XCTAssertEqual(session.totalCards, 2)
    }

    func testMergeRepeatsOffCreatesNewLine() async throws {
        let session = ScanSession()
        let start = Date()
        let config = settings(mergeRepeats: false)

        XCTAssertTrue(session.add(record: record, score: 0.9, crop: nil, settings: config, at: start))
        session.markFrameEmpty()
        XCTAssertTrue(
            session.add(
                record: record,
                score: 0.9,
                crop: nil,
                settings: config,
                at: start.addingTimeInterval(0.6)
            )
        )

        XCTAssertEqual(session.lines.count, 2)
        XCTAssertEqual(session.totalCards, 2)
    }

    func testDifferentConditionCreatesNewLine() async throws {
        let session = ScanSession()
        let start = Date()
        XCTAssertTrue(session.add(record: record, score: 0.9, crop: nil, settings: settings(), at: start))
        XCTAssertTrue(
            session.add(
                record: record,
                score: 0.9,
                crop: nil,
                settings: settings(condition: "SP"),
                at: start.addingTimeInterval(0.1)
            )
        )
        XCTAssertEqual(session.lines.count, 2)
    }

    func testQuantityRemoveAndClear() async throws {
        let session = ScanSession()
        XCTAssertTrue(session.add(record: record, score: 0.9, crop: nil, settings: settings()))
        let id = try XCTUnwrap(session.lines.first?.id)
        session.setQuantity(id: id, n: 5)
        XCTAssertEqual(session.totalCards, 5)
        session.setQuantity(id: id, n: 0)
        XCTAssertEqual(session.totalCards, 5)
        session.remove(id: id)
        XCTAssertTrue(session.lines.isEmpty)
        session.markFrameEmpty()
        XCTAssertTrue(session.add(record: record, score: 0.9, crop: nil, settings: settings()))
        session.clear()
        XCTAssertTrue(session.lines.isEmpty)
        XCTAssertEqual(session.totalCards, 0)
    }

    func testPayloadMatchesContract() async throws {
        let session = ScanSession()
        let config = settings()
        XCTAssertTrue(session.add(record: record, score: 0.9, crop: nil, settings: config))

        let payload = session.payload(intent: "collection", idempotencyKey: "key-12345678", photoIds: [:])
        let data = try JSONEncoder().encode(payload)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["idempotencyKey"] as? String, "key-12345678")
        XCTAssertEqual(object["intent"] as? String, "collection")

        let cards = try XCTUnwrap(object["cards"] as? [[String: Any]])
        XCTAssertEqual(cards.count, 1)
        let card = cards[0]
        XCTAssertEqual(card["language"] as? String, "EN")
        XCTAssertEqual(card["condition"] as? String, "NM")
        XCTAssertEqual(card["printing"] as? String, "Standard")
        XCTAssertEqual(card["quantity"] as? Int, 1)
        XCTAssertEqual(card["price"] as? Double, 0)
        XCTAssertEqual(card["firstEdition"] as? Bool, false)
        XCTAssertEqual(card["signed"] as? Bool, false)
        XCTAssertEqual(card["altered"] as? Bool, false)
        XCTAssertEqual(card["art"] as? String, "https://img/p1.png")
        XCTAssertNil(card["photoId"])

        let identity = try XCTUnwrap(card["identity"] as? [String: Any])
        XCTAssertEqual(identity["game"] as? String, "pokemon")
        XCTAssertEqual(identity["name"] as? String, "Pikachu")
        XCTAssertEqual(identity["setName"] as? String, "Base")
        XCTAssertEqual(identity["number"] as? String, "58")
        XCTAssertEqual(identity["publicId"] as? String, "p1")
        XCTAssertEqual(identity["cardtraderBlueprintId"] as? String, "")
    }
}
