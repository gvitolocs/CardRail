import CoreGraphics
import Foundation

/// Decides when the card in front of the camera has stopped moving, so a scan
/// is triggered once per placement. Pure value type: fully unit-tested.
struct FrameStabilizer {
    /// A quad center must move less than this fraction of the frame.
    var centerTolerance: CGFloat = 0.025
    /// A quad area may change by less than this fraction.
    var areaTolerance: CGFloat = 0.06
    /// Consecutive still frames required (the first frame establishes the pose).
    var requiredStillFrames = 2

    private struct Sample {
        let center: CGPoint
        let area: CGFloat
    }

    private var previous: Sample?
    private var stillCount = 0

    /// Forget the current placement; the next two frames are needed again.
    mutating func reset() {
        previous = nil
        stillCount = 0
    }

    /// Feed one detected quad. Returns `true` when the card has been still for
    /// `requiredStillFrames` consecutive frames.
    @discardableResult
    mutating func observe(_ quad: [CGPoint]) -> Bool {
        guard quad.count == 4 else {
            reset()
            return false
        }

        let sample = Sample(center: center(quad), area: area(quad))
        defer { previous = sample }

        guard let previous else {
            stillCount = 1
            return false
        }

        let moved = hypot(
            sample.center.x - previous.center.x,
            sample.center.y - previous.center.y
        )
        let reference = max(previous.area, 0.0001)
        let areaChanged = abs(sample.area - previous.area) / reference

        if moved < centerTolerance, areaChanged < areaTolerance {
            stillCount += 1
        } else {
            stillCount = 1
        }
        return stillCount >= requiredStillFrames
    }

    private func center(_ quad: [CGPoint]) -> CGPoint {
        let sum = quad.reduce(CGPoint.zero) { CGPoint(x: $0.x + $1.x, y: $0.y + $1.y) }
        return CGPoint(x: sum.x / 4, y: sum.y / 4)
    }

    private func area(_ quad: [CGPoint]) -> CGFloat {
        var total: CGFloat = 0
        for index in 0..<4 {
            let current = quad[index]
            let next = quad[(index + 1) % 4]
            total += current.x * next.y - next.x * current.y
        }
        return abs(total) / 2
    }
}
