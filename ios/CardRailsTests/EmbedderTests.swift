import CoreGraphics
import ImageIO
import XCTest
@testable import CardRails

final class EmbedderTests: XCTestCase {
    func testEmbeddingMatchesFixture() throws {
        let bundle = Bundle(for: EmbedderTests.self)
        guard
            let imageURL = bundle.url(forResource: "card", withExtension: "jpg"),
            let embeddingURL = bundle.url(forResource: "card.embedding", withExtension: "json")
        else {
            throw XCTSkip("Fixtures/card.jpg and card.embedding.json are not present.")
        }
        guard
            let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw XCTSkip("Could not load Fixtures/card.jpg.")
        }
        let expected = try JSONDecoder().decode([Float].self, from: Data(contentsOf: embeddingURL))

        let embedder = try Embedder()
        let actual = try embedder.embed(image)
        XCTAssertEqual(actual.count, expected.count)

        let cosine = zip(actual, expected).reduce(Float(0)) { $0 + $1.0 * $1.1 }
        XCTAssertGreaterThanOrEqual(cosine, 0.98)
    }
}
