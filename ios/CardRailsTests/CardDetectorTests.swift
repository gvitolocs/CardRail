import CoreGraphics
import CoreImage
import CoreVideo
import ImageIO
import XCTest
@testable import CardRails

final class CardRectangleSelectorTests: XCTestCase {
    private let frame = CGSize(width: 600, height: 800)
    private func rectangle(_ bounds: CGRect, confidence: Float = 1) -> CardRectangle {
        CardRectangle(quad: [CGPoint(x: bounds.minX, y: bounds.minY), CGPoint(x: bounds.maxX, y: bounds.minY), CGPoint(x: bounds.maxX, y: bounds.maxY), CGPoint(x: bounds.minX, y: bounds.maxY)], confidence: confidence)
    }
    func testAspectUsesPixelsNotNormalizedFrameCoordinates() {
        let card = rectangle(CGRect(x: 0.2, y: 0.17, width: 0.6, height: 0.63))
        XCTAssertEqual(card.aspect(in: frame), 0.714, accuracy: 0.002)
        XCTAssertTrue(CardRectangleSelector().isPlausible(card, frameSize: frame))
    }
    func testOuterCardWinsOverTextAndArtworkPanelsEvenIfPanelConfidenceIsHigher() {
        let outer = rectangle(CGRect(x: 0.2, y: 0.17, width: 0.6, height: 0.63), confidence: 0.8)
        let panel = rectangle(CGRect(x: 0.3, y: 0.27, width: 0.4, height: 0.42))
        var selector = CardRectangleSelector()
        XCTAssertEqual(selector.select([panel, outer], frameSize: frame), 1)
    }
    func testRejectsWholeFrameSmallLabelsLowConfidenceAndPeripheralObjects() {
        let cases = [
            rectangle(CGRect(x: 0, y: 0, width: 1, height: 1)),
            rectangle(CGRect(x: 0.45, y: 0.45, width: 0.1, height: 0.105)),
            rectangle(CGRect(x: 0.2, y: 0.17, width: 0.6, height: 0.63), confidence: 0.3),
            rectangle(CGRect(x: 0, y: 0.27, width: 0.4, height: 0.42)),
            rectangle(CGRect(x: 0.2, y: 0.3, width: 0.6, height: 0.1)),
        ]
        for candidate in cases { XCTAssertFalse(CardRectangleSelector().isPlausible(candidate, frameSize: frame)) }
        var selector = CardRectangleSelector()
        XCTAssertNil(selector.select(cases, frameSize: frame))
    }
    func testFollowsSameCardInsteadOfJumpingToNewLargerCard() {
        let locked = rectangle(CGRect(x: 0.1, y: 0.26, width: 0.42, height: 0.44))
        let other = rectangle(CGRect(x: 0.45, y: 0.2, width: 0.5, height: 0.53))
        var selector = CardRectangleSelector()
        XCTAssertEqual(selector.select([locked], frameSize: frame), 0)
        XCTAssertEqual(selector.select([other, locked], frameSize: frame), 1)
        for _ in 0..<8 { XCTAssertNil(selector.select([], frameSize: frame)) }
        XCTAssertNil(selector.previous)
        XCTAssertEqual(selector.select([other], frameSize: frame), 0)
    }
    func testLandscapeAndRotatedCardUseEdgeLengths() {
        let size = CGSize(width: 800, height: 600)
        let landscape = rectangle(CGRect(x: 0.17, y: 0.2, width: 0.63, height: 0.6))
        XCTAssertTrue(CardRectangleSelector().isPlausible(landscape, frameSize: size))
        let center = CGPoint(x: 300, y: 400), angle = CGFloat.pi / 6
        let pixelPoints = [CGPoint(x: -150,y: -210), CGPoint(x: 150,y: -210), CGPoint(x: 150,y: 210), CGPoint(x: -150,y: 210)]
        let quad = pixelPoints.map { p in CGPoint(x: (center.x + p.x * cos(angle) - p.y * sin(angle)) / frame.width, y: (center.y + p.x * sin(angle) + p.y * cos(angle)) / frame.height) }
        XCTAssertTrue(CardRectangleSelector().isPlausible(CardRectangle(quad: quad, confidence: 1), frameSize: frame))
    }
}

final class CardDetectorTests: XCTestCase {
    private func fixture() throws -> CGImage {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "card", withExtension: "jpg"))
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    }
    func testRealCardPhotoFindsActualCornersInsteadOfCenterFallback() throws {
        let card = try XCTUnwrap(CardDetector().crop(still: fixture()))
        XCTAssertGreaterThanOrEqual(card.confidence, 0.7)
        XCTAssertEqual(card.image.width, 252)
        XCTAssertEqual(card.image.height, 352)
        XCTAssertEqual(card.quad.count, 4)
        XCTAssertGreaterThan(card.quad[0].y, 0.1)
        XCTAssertLessThan(card.quad[2].y, 0.9)
    }
    func testSameRealPhotoAsLandscapeSensorFrameDetectsUprightCard() throws {
        let image = CIImage(cgImage: try fixture()).oriented(.left)
        let extent = image.extent
        let shifted = image.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, Int(extent.width), Int(extent.height), kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer), kCVReturnSuccess)
        let pixelBuffer = try XCTUnwrap(buffer)
        CIContext().render(shifted, to: pixelBuffer)
        let card = try XCTUnwrap(CardDetector().detect(in: pixelBuffer, orientation: .right))
        XCTAssertGreaterThanOrEqual(card.confidence, 0.7)
        XCTAssertGreaterThan(card.quad[0].y, 0.1)
        XCTAssertLessThan(card.quad[2].y, 0.9)
    }
}
