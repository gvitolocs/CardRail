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
}
