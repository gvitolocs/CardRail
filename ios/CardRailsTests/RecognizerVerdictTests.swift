import XCTest
@testable import CardRails

final class RecognizerVerdictTests: XCTestCase {
    private func match(_ name: String, _ score: Float) -> Match {
        Match(record: CardRecord(id: name + "\(score)", name: name, number: nil, set: nil, imageURL: nil), score: score)
    }

    private func verdict(_ matches: [Match]) throws -> Recognizer.Verdict {
        Recognizer(embedder: try Embedder()).verdict(matches)
    }

    func testClearWinnerIsAccepted() throws {
        guard case .accepted(let top) = try verdict([match("Momonosuke", 0.897), match("DON!!", 0.787)]) else {
            return XCTFail("expected accepted")
        }
        XCTAssertEqual(top.record.name, "Momonosuke")
    }

    func testCloseRivalGoesToReview() throws {
        guard case .review = try verdict([match("Sabo", 0.84), match("Ace", 0.81)]) else {
            return XCTFail("expected review")
        }
    }

    func testSameNamePrintsDoNotBlockAcceptance() throws {
        guard case .accepted = try verdict([match("Momonosuke", 0.90), match("Momonosuke", 0.89), match("DON!!", 0.70)]) else {
            return XCTFail("expected accepted")
        }
    }

    func testLowScoresAreIgnored() throws {
        guard case .none = try verdict([match("Sabo", 0.55)]) else { return XCTFail("expected none") }
        guard case .review = try verdict([match("Sabo", 0.70)]) else { return XCTFail("expected review") }
    }

    func testFillerWinnerIsIgnoredWithoutPromotingEnergy() throws {
        let matches = [match("Blank Filler Card", 0.99), match("Grass Energy", 0.90)]
        guard case .none = try verdict(matches) else { return XCTFail("expected none") }
    }

    func testFillerNeverAppearsInReview() throws {
        guard case .review(let matches) = try verdict([
            match("Pikachu", 0.74), match("Blank Filler Card", 0.70)
        ]) else { return XCTFail("expected review") }
        XCTAssertEqual(matches.map { $0.record.name }, ["Pikachu"])
    }

    func testCachedFillerVectorWinnerRejectsFrame() {
        let records = [match("Blank Filler Card", 1).record, match("Grass Energy", 1).record]
        XCTAssertTrue(Recognizer.catalogMatches(
            [(index: 0, score: 0.99), (index: 1, score: 0.90)], records: records
        ).isEmpty)
        XCTAssertEqual(Recognizer.catalogMatches(
            [(index: 1, score: 0.99), (index: 0, score: 0.90)], records: records
        ).map { $0.record.name }, ["Grass Energy"])
    }

    func testInvalidVectorIndexDoesNotCreateBlankCard() {
        let records = [match("Pikachu", 1).record]
        XCTAssertTrue(Recognizer.catalogMatches(
            [(index: 4, score: 0.99)], records: records
        ).isEmpty)
        XCTAssertEqual(Recognizer.catalogMatches(
            [(index: 0, score: 0.99), (index: -1, score: 0.9)], records: records
        ).count, 1)
    }

    func testFillerCategoryPreservesPlayableCards() throws {
        for name in ["Blank Filler Card", "Discard Filler Card", "Barcode Filler Card"] {
            XCTAssertTrue(match(name, 1).record.isFiller)
        }
        let category = CardRecord(id: "99446", name: "WCD 1996", number: nil,
                                  set: "Filler Cards", imageURL: nil)
        XCTAssertTrue(category.isFiller)
        for name in ["Grass Energy", "Go Blank", "Blanket of Night", "Training Dummy"] {
            XCTAssertFalse(match(name, 1).record.isFiller)
            guard case .accepted = try verdict([match(name, 0.95)]) else {
                return XCTFail("playable card was excluded: \(name)")
            }
        }
    }
}
