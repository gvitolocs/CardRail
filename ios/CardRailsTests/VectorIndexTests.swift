import XCTest
@testable import CardRails

final class VectorIndexTests: XCTestCase {
    private func makeVectors(count: Int, dim: Int = 128) -> [[Float]] {
        var generator = SystemRandomNumberGenerator()
        return (0..<count).map { _ in
            var vector = (0..<dim).map { _ in Float.random(in: -1...1, using: &generator) }
            let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
            vector = vector.map { $0 / norm }
            return vector
        }
    }

    private func encodeF16(_ vectors: [[Float]]) -> Data {
        var bits: [UInt16] = []
        for vector in vectors {
            for value in vector { bits.append(Float16(value).bitPattern) }
        }
        return bits.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    func testFindsExactRow() throws {
        let vectors = makeVectors(count: 1000)
        let index = try VectorIndex(f16: encodeF16(vectors), count: 1000)

        let results = index.search(vectors[123], k: 5)
        XCTAssertEqual(results.count, 5)
        XCTAssertEqual(results.first?.index, 123)
        XCTAssertEqual(results.first!.score, 1.0, accuracy: 2e-3)

        for pair in zip(results, results.dropFirst()) {
            XCTAssertGreaterThanOrEqual(pair.0.score, pair.1.score)
        }
    }

    func testKGreaterThanCount() throws {
        let vectors = makeVectors(count: 3)
        let index = try VectorIndex(f16: encodeF16(vectors), count: 3)
        XCTAssertEqual(index.search(vectors[0], k: 10).count, 3)
    }

    func testEmptyIndex() throws {
        let index = try VectorIndex(f16: Data(), count: 0)
        XCTAssertTrue(index.search([Float](repeating: 1, count: 128), k: 5).isEmpty)
    }

    func testZeroQueryScoresZero() throws {
        let vectors = makeVectors(count: 10)
        let index = try VectorIndex(f16: encodeF16(vectors), count: 10)
        let results = index.search([Float](repeating: 0, count: 128), k: 3)
        XCTAssertEqual(results.count, 3)
        XCTAssertTrue(results.allSatisfy { $0.score == 0 })
    }

    func testWrongSizeThrows() {
        XCTAssertThrowsError(try VectorIndex(f16: Data(repeating: 0, count: 10), count: 4))
    }
}
