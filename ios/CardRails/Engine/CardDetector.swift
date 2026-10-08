import CoreImage
import CoreVideo
import Foundation
import ImageIO
import Vision

struct DetectedCard {
    /// Upright 252x352 card crop.
    let image: CGImage
    /// Four corners in normalized image space, top-left origin, for UI overlay:
    /// [topLeft, topRight, bottomRight, bottomLeft].
    let quad: [CGPoint]
    let confidence: Float
}

enum CardDetectorError: Error {
    case correctionFailed
}

/// Finds a card in a camera frame with Vision rectangle detection and
/// perspective-corrects it into an upright 252x352 portrait crop.
final class CardDetector {
    private let ciContext: CIContext
    private var selector = CardRectangleSelector()
    private var lastDiagnosticAt = Date.distantPast

    init() {
        self.ciContext = CIContext(options: [.useSoftwareRenderer: false])
    }

    func detect(
        in pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation
    ) throws -> DetectedCard? {
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation)
        let request = Self.rectangleRequest()
        try handler.perform([request])
        let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let observations = request.results ?? []
        let candidates = observations.map { rectangle($0) }
        let selected = selector.select(candidates, frameSize: image.extent.size)
        if Date().timeIntervalSince(lastDiagnosticAt) >= 2 {
            lastDiagnosticAt = Date()
            let details = candidates.map { String(format: "aspect=%.3f area=%.3f conf=%.2f", Double($0.aspect(in: image.extent.size)), Double($0.area), Double($0.confidence)) }.joined(separator: "; ")
            ScanDiagnostics.shared.record("vision frame=\(Int(image.extent.width))x\(Int(image.extent.height)) candidates=\(candidates.count) selected=\(selected.map(String.init) ?? "none") \(details)")
        }
        guard let selected else { return nil }
        return try card(from: observations[selected], in: image)
    }

    /// Detect a card in a still photo. If no rectangle is found, fall back to
    /// the center 63:88 crop so a photo of a single card still works.
    func crop(still: CGImage) throws -> DetectedCard? {
        let handler = VNImageRequestHandler(cgImage: still, orientation: .up)
        let request = Self.rectangleRequest()
        try handler.perform([request])

        let image = CIImage(cgImage: still)
        let observations = request.results ?? []
        var stillSelector = CardRectangleSelector()
        if let selected = stillSelector.select(observations.map { rectangle($0) }, frameSize: image.extent.size) {
            return try card(from: observations[selected], in: image)
        }
        return centerCrop(still)
    }

    private static func rectangleRequest() -> VNDetectRectanglesRequest {
        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 0.3
        request.maximumAspectRatio = 1.0
        request.minimumSize = 0.1
        request.quadratureTolerance = 30
        // Request broad candidates; gate confidence and physical card geometry ourselves.
        request.minimumConfidence = 0.0
        request.maximumObservations = 16
        return request
    }

    private func rectangle(_ observation: VNRectangleObservation) -> CardRectangle {
        CardRectangle(quad: [uiPoint(observation.topLeft), uiPoint(observation.topRight), uiPoint(observation.bottomRight), uiPoint(observation.bottomLeft)], confidence: observation.confidence)
    }

    private func card(
        from observation: VNRectangleObservation,
        in image: CIImage
    ) throws -> DetectedCard? {
        let extent = image.extent
        func point(_ normalized: CGPoint) -> CGPoint {
            CGPoint(
                x: extent.origin.x + normalized.x * extent.width,
                y: extent.origin.y + normalized.y * extent.height
            )
        }

        guard
            let filter = CIFilter(name: "CIPerspectiveCorrection")
        else { throw CardDetectorError.correctionFailed }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(CIVector(cgPoint: point(observation.topLeft)), forKey: "inputTopLeft")
        filter.setValue(CIVector(cgPoint: point(observation.topRight)), forKey: "inputTopRight")
        filter.setValue(CIVector(cgPoint: point(observation.bottomLeft)), forKey: "inputBottomLeft")
        filter.setValue(CIVector(cgPoint: point(observation.bottomRight)), forKey: "inputBottomRight")
        guard let corrected = filter.outputImage, let upright = normalize(corrected) else {
            throw CardDetectorError.correctionFailed
        }

        let quad = [
            uiPoint(observation.topLeft),
            uiPoint(observation.topRight),
            uiPoint(observation.bottomRight),
            uiPoint(observation.bottomLeft),
        ]
        return DetectedCard(image: upright, quad: quad, confidence: observation.confidence)
    }

    private func centerCrop(_ still: CGImage) -> DetectedCard? {
        let width = CGFloat(still.width)
        let height = CGFloat(still.height)
        guard width > 0, height > 0 else { return nil }

        let aspect = CGFloat(63.0 / 88.0)
        var cropWidth = width
        var cropHeight = width / aspect
        if cropHeight > height {
            cropHeight = height
            cropWidth = height * aspect
        }
        let rect = CGRect(
            x: (width - cropWidth) / 2,
            y: (height - cropHeight) / 2,
            width: cropWidth,
            height: cropHeight
        )
        let cropped = CIImage(cgImage: still).cropped(to: rect)
        guard let upright = normalize(cropped) else { return nil }

        let minX = rect.minX / width
        let maxX = rect.maxX / width
        let minY = 1 - rect.maxY / height
        let maxY = 1 - rect.minY / height
        let quad = [
            CGPoint(x: minX, y: minY),
            CGPoint(x: maxX, y: minY),
            CGPoint(x: maxX, y: maxY),
            CGPoint(x: minX, y: maxY),
        ]
        return DetectedCard(image: upright, quad: quad, confidence: 0)
    }

    /// Stretch to 252x352, rotating a landscape quad to portrait first.
    private func normalize(_ source: CIImage) -> CGImage? {
        var image = source
        var size = image.extent.size
        guard size.width > 0, size.height > 0 else { return nil }

        if size.width > size.height {
            image = image.transformed(by: CGAffineTransform(rotationAngle: -CGFloat.pi / 2))
            size = image.extent.size
        }

        let target = CGSize(width: 252, height: 352)
        image = image.transformed(
            by: CGAffineTransform(
                scaleX: target.width / size.width,
                y: target.height / size.height
            )
        )
        let extent = image.extent
        image = image.transformed(
            by: CGAffineTransform(translationX: -extent.origin.x, y: -extent.origin.y)
        )
        return ciContext.createCGImage(
            image,
            from: CGRect(x: 0, y: 0, width: target.width, height: target.height)
        )
    }

    /// Vision uses a bottom-left origin; UI overlays use top-left.
    private func uiPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x, y: 1 - point.y)
    }
}
