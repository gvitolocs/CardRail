import CoreGraphics
import Foundation

struct Match: Hashable {
    let record: CardRecord
    let score: Float
}

final class Recognizer {
    enum Verdict {
        case accepted(Match)
        case review([Match])
        case none
    }

    static let acceptScore: Float = 0.80
    static let reviewScore: Float = 0.60
    /// The best card with a different name must trail by this much; prints of the
    /// same card (e.g. OP16-085 and its parallel 085a) sit close and don't count.
    static let acceptMargin: Float = 0.06

    let embedder: Embedder
    private(set) var catalog: LoadedCatalog?
    private(set) var lastTimingMs: Double = 0

    init(embedder: Embedder) {
        self.embedder = embedder
    }

    func setCatalog(_ catalog: LoadedCatalog) {
        self.catalog = catalog
    }

    /// Drop the current catalog so scans are ignored while another loads.
    func clearCatalog() {
        self.catalog = nil
    }

    /// Embed the card both upright and rotated 180° and keep the better result,
    /// since a card may be upside down in front of the camera.
    func identify(_ card: CGImage, k: Int = 5) throws -> [Match] {
        guard let catalog = catalog else { return [] }
        let started = Date()

        let upright = try embedder.embed(card)
        let uprightResults = catalog.index.search(upright, k: k)

        let flipped = try embedder.embed(Self.rotate180(card))
        let flippedResults = catalog.index.search(flipped, k: k)

        let bestUpright = uprightResults.first?.score ?? 0
        let bestFlipped = flippedResults.first?.score ?? 0
        let results = bestFlipped > bestUpright ? flippedResults : uprightResults

        lastTimingMs = Date().timeIntervalSince(started) * 1000
        return Self.catalogMatches(results, records: catalog.records)
    }

    static func catalogMatches(
        _ results: [(index: Int, score: Float)], records: [CardRecord]
    ) -> [Match] {
        guard let top = results.first,
              records.indices.contains(top.index),
              records[top.index].isScanCandidate else {
            // An old cached catalog can still contain filler vectors. If one
            // wins, ignore the frame instead of promoting a weaker real card.
            if let top = results.first, records.indices.contains(top.index),
               records[top.index].isFiller {
                ScanDiagnostics.shared.record("recognition ignored filler reference score=\(top.score)")
            }
            return []
        }
        return results.compactMap { result in
            guard records.indices.contains(result.index),
                  records[result.index].isScanCandidate else { return nil }
            return Match(record: records[result.index], score: result.score)
        }
    }

    func verdict(_ matches: [Match]) -> Verdict {
        guard let top = matches.first, top.record.isScanCandidate else { return .none }
        let matches = matches.filter { $0.record.isScanCandidate }
        let rival = matches.dropFirst().first { $0.record.name != top.record.name }
        if top.score >= Self.acceptScore,
           top.score - (rival?.score ?? 0) >= Self.acceptMargin {
            return .accepted(top)
        }
        if top.score >= Self.reviewScore { return .review(matches) }
        return .none
    }

    private static func rotate180(_ image: CGImage) -> CGImage {
        let width = image.width
        let height = image.height
        guard
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return image }
        context.translateBy(x: CGFloat(width), y: CGFloat(height))
        context.rotate(by: .pi)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
    }
}
