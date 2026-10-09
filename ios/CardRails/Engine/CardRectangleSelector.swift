import CoreGraphics
import Foundation

/// Card geometry and single-card lock rules from the Pokoin live scanner.
/// Coordinates are normalized in the upright frame, with a top-left origin.
struct CardRectangle {
    let quad: [CGPoint]
    let confidence: Float

    var bounds: CGRect {
        let xs = quad.map(\.x), ys = quad.map(\.y)
        return CGRect(x: xs.min() ?? 0, y: ys.min() ?? 0,
                      width: (xs.max() ?? 0) - (xs.min() ?? 0),
                      height: (ys.max() ?? 0) - (ys.min() ?? 0))
    }
    var area: CGFloat {
        guard quad.count == 4 else { return 0 }
        return abs((0..<4).reduce(CGFloat.zero) { sum, i in
            let a = quad[i], b = quad[(i + 1) % 4]
            return sum + a.x * b.y - b.x * a.y
        }) / 2
    }
    func aspect(in size: CGSize) -> CGFloat {
        guard quad.count == 4 else { return 0 }
        func edge(_ a: Int, _ b: Int) -> CGFloat {
            hypot((quad[a].x - quad[b].x) * size.width,
                  (quad[a].y - quad[b].y) * size.height)
        }
        let width = (edge(0, 1) + edge(3, 2)) / 2
        let height = (edge(0, 3) + edge(1, 2)) / 2
        guard min(width, height) >= 48 else { return 0 }
        return min(width, height) / max(width, height)
    }
}

struct CardRectangleSelector {
    // Same 63:88 bounds, center gate and object lock as Pokoin Single.
    static let aspectRange: ClosedRange<CGFloat> = 0.58...0.88
    static let areaRange: ClosedRange<CGFloat> = 0.12...0.72
    static let maxCenterOffset: CGFloat = 0.28
    static let minimumConfidence: Float = 0.70
    static let lockOverlap: CGFloat = 0.40

    private(set) var previous: CardRectangle?
    private var misses = 0

    mutating func reset() { previous = nil; misses = 0 }

    func isPlausible(_ candidate: CardRectangle, frameSize: CGSize) -> Bool {
        guard frameSize.width > 0, frameSize.height > 0,
              candidate.quad.count == 4,
              candidate.quad.allSatisfy({ $0.x.isFinite && $0.y.isFinite && (0...1).contains($0.x) && (0...1).contains($0.y) }),
              candidate.confidence >= Self.minimumConfidence,
              Self.aspectRange.contains(candidate.aspect(in: frameSize)),
              Self.areaRange.contains(candidate.area) else { return false }
        let bounds = candidate.bounds
        guard abs(bounds.midX - 0.5) <= Self.maxCenterOffset,
              abs(bounds.midY - 0.5) <= Self.maxCenterOffset else { return false }
        // Reject the screen/frame border rather than locking onto it.
        let mx = 18 / frameSize.width, my = 18 / frameSize.height
        return !(bounds.minX <= mx && bounds.minY <= my && bounds.maxX >= 1 - mx && bounds.maxY >= 1 - my)
    }

    mutating func select(_ candidates: [CardRectangle], frameSize: CGSize) -> Int? {
        let plausible = candidates.indices.filter { isPlausible(candidates[$0], frameSize: frameSize) }
        // An artwork/text panel inside an outer card is not a separate card.
        let outer = plausible.filter { inner in
            !plausible.contains { host in
                guard host != inner, candidates[host].area > candidates[inner].area * 1.15 else { return false }
                let overlap = intersection(candidates[inner].bounds, candidates[host].bounds)
                return overlap / max(candidates[inner].bounds.width * candidates[inner].bounds.height, 0.0001) >= 0.72
            }
        }
        guard !outer.isEmpty else {
            misses += 1
            if misses >= 8 { previous = nil }
            return nil
        }
        let followed = previous.map { last in outer.filter { iou(candidates[$0].bounds, last.bounds) >= Self.lockOverlap } } ?? []
        let pool = followed.isEmpty ? outer : followed
        let selected = pool.max { a, b in
            if candidates[a].area != candidates[b].area { return candidates[a].area < candidates[b].area }
            let aa = candidates[a].bounds, bb = candidates[b].bounds
            return hypot(aa.midX - 0.5, aa.midY - 0.5) > hypot(bb.midX - 0.5, bb.midY - 0.5)
        }!
        previous = candidates[selected]; misses = 0
        return selected
    }

    private func intersection(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let rect = a.intersection(b)
        return rect.isNull ? 0 : rect.width * rect.height
    }
    private func iou(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let overlap = intersection(a, b)
        return overlap / max(a.width * a.height + b.width * b.height - overlap, 0.0001)
    }
}
