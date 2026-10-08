import CoreImage
import CoreML
import Foundation
import Vision

enum EmbedderError: Error {
    case modelNotFound
    case invalidInput
    case invalidOutput
}

/// Runs the MiloCNN Core ML model that maps a 448x448 card crop to a
/// 128-dimensional L2-normalized embedding.
final class Embedder {
    private let model: MLModel
    private let inputName = "image"
    private let outputName = "embedding"

    init(bundle: Bundle = .main) throws {
        guard
            let url = bundle.url(forResource: "MiloCNN", withExtension: "mlmodelc")
        else {
            throw EmbedderError.modelNotFound
        }
        let configuration = MLModelConfiguration()
        #if targetEnvironment(simulator)
        // The simulator's GPU path returns an all-zero embedding for this model.
        configuration.computeUnits = .cpuOnly
        #else
        configuration.computeUnits = .all
        #endif
        self.model = try MLModel(contentsOf: url, configuration: configuration)
    }

    /// Embed a single image. The catalog was built by stretching the card crop
    /// to 448x448, so the input uses `.scaleFill` (stretch, no letterboxing).
    func embed(_ image: CGImage) throws -> [Float] {
        let feature = try MLFeatureValue(
            cgImage: image,
            pixelsWide: 448,
            pixelsHigh: 448,
            pixelFormatType: kCVPixelFormatType_32BGRA,
            options: [.cropAndScale: VNImageCropAndScaleOption.scaleFill.rawValue]
        )
        let provider = try MLDictionaryFeatureProvider(dictionary: [inputName: feature])
        let output = try model.prediction(from: provider)
        guard let array = output.featureValue(for: outputName)?.multiArrayValue else {
            throw EmbedderError.invalidOutput
        }

        var floats = [Float](repeating: 0, count: array.count)
        for i in 0..<array.count {
            floats[i] = array[i].floatValue
        }
        return Embedder.normalize(floats)
    }

    /// Run one prediction on a blank image so the first real scan is fast.
    /// Call off the main thread at app start.
    func warmUp() {
        guard
            let context = CGContext(
                data: nil,
                width: 448,
                height: 448,
                bitsPerComponent: 8,
                bytesPerRow: 448 * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
            )
        else { return }
        context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 448, height: 448))
        if let image = context.makeImage() {
            _ = try? embed(image)
        }
    }

    private static func normalize(_ values: [Float]) -> [Float] {
        var sum: Float = 0
        for value in values { sum += value * value }
        let norm = sqrt(sum)
        guard norm > 0 else { return values }
        return values.map { $0 / norm }
    }
}
