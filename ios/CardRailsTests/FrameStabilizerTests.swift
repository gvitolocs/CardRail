import CoreGraphics
import XCTest
@testable import CardRails

final class FrameStabilizerTests: XCTestCase {
    private func quad(center: CGPoint, size: CGFloat) -> [CGPoint] {
        let half = size / 2
        return [
            CGPoint(x: center.x - half, y: center.y - half),
            CGPoint(x: center.x + half, y: center.y - half),
            CGPoint(x: center.x + half, y: center.y + half),
            CGPoint(x: center.x - half, y: center.y + half),
        ]
    }

    func testStableAfterTwoStillFrames() {
        var stabilizer = FrameStabilizer()
        let card = quad(center: CGPoint(x: 0.5, y: 0.5), size: 0.5)

        XCTAssertFalse(stabilizer.observe(card))
        XCTAssertTrue(stabilizer.observe(card))
    }

    func testMovingQuadNeverStable() {
        var stabilizer = FrameStabilizer()
        var center: CGFloat = 0.2
        for _ in 0..<20 {
            let moving = quad(center: CGPoint(x: center, y: 0.5), size: 0.4)
            XCTAssertFalse(stabilizer.observe(moving))
            center += 0.05
        }
    }

    func testAreaChangeIsNotStable() {
        var stabilizer = FrameStabilizer()
        let small = quad(center: CGPoint(x: 0.5, y: 0.5), size: 0.5)
        let large = quad(center: CGPoint(x: 0.5, y: 0.5), size: 0.6)

        XCTAssertFalse(stabilizer.observe(small))
        XCTAssertFalse(stabilizer.observe(large))
        XCTAssertTrue(stabilizer.observe(large))
    }

    func testResetAfterAccept() {
        var stabilizer = FrameStabilizer()
        let card = quad(center: CGPoint(x: 0.5, y: 0.5), size: 0.5)

        XCTAssertFalse(stabilizer.observe(card))
        XCTAssertTrue(stabilizer.observe(card))

        stabilizer.reset()
        XCTAssertFalse(stabilizer.observe(card))
        XCTAssertTrue(stabilizer.observe(card))
    }

    func testResetOnEmptyFrame() {
        var stabilizer = FrameStabilizer()
        let card = quad(center: CGPoint(x: 0.5, y: 0.5), size: 0.5)

        XCTAssertFalse(stabilizer.observe(card))
        XCTAssertTrue(stabilizer.observe(card))

        XCTAssertFalse(stabilizer.observe([]))
        XCTAssertFalse(stabilizer.observe(card))
        XCTAssertTrue(stabilizer.observe(card))
    }
}
