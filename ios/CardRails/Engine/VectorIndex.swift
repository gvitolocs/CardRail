import Accelerate
import Foundation

enum VectorIndexError: Error, Equatable {
    case invalidSize
}

/// A fixed matrix of L2-normalized float vectors loaded from little-endian
/// float16 bytes, with a fast cosine (dot-product) top-k search.
final class VectorIndex {
    let count: Int
    let dim: Int

    private let vectors: [Float]

    init(f16 data: Data, count: Int, dim: Int = 128) throws {
        guard count >= 0, dim > 0, data.count == count * dim * 2 else {
            throw VectorIndexError.invalidSize
        }
        self.count = count
        self.dim = dim
        self.vectors = VectorIndex.decodeF16(data, elements: count * dim)
    }

    /// Cosine search. The query is L2-normalized internally; a zero query
    /// yields all-zero scores. Results are sorted by score descending.
    func search(_ query: [Float], k: Int) -> [(index: Int, score: Float)] {
        guard count > 0, k > 0, query.count == dim else { return [] }
        let limit = min(k, count)

        var q = query
        var sum: Float = 0
        for value in q { sum += value * value }
        let norm = sqrt(sum)
        if norm > 0 {
            for i in 0..<dim { q[i] /= norm }
        }

        var scores = [Float](repeating: 0, count: count)
        cblas_sgemv(
            CblasRowMajor,
            CblasNoTrans,
            Int32(count),
            Int32(dim),
            1.0,
            vectors,
            Int32(dim),
            q,
            1,
            0.0,
            &scores,
            1
        )

        var best: [(index: Int, score: Float)] = []
        best.reserveCapacity(limit)
        for i in 0..<count {
            let score = scores[i]
            if best.count < limit {
                var j = best.count
                while j > 0 && best[j - 1].score < score { j -= 1 }
                best.insert((i, score), at: j)
            } else if score > best[limit - 1].score {
                var j = limit - 1
                while j > 0 && best[j - 1].score < score { j -= 1 }
                best.insert((i, score), at: j)
                best.removeLast()
            }
        }
        return best
    }

    private static func decodeF16(_ data: Data, elements: Int) -> [Float] {
        guard elements > 0 else { return [] }
        var floats = [Float](repeating: 0, count: elements)
        let width = vImagePixelCount(elements)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let source = raw.baseAddress else { return }
            var src = vImage_Buffer(
                data: UnsafeMutableRawPointer(mutating: source),
                height: 1,
                width: width,
                rowBytes: elements * 2
            )
            floats.withUnsafeMutableBytes { (dest: UnsafeMutableRawBufferPointer) in
                var dst = vImage_Buffer(
                    data: dest.baseAddress,
                    height: 1,
                    width: width,
                    rowBytes: elements * 4
                )
                _ = vImageConvert_Planar16FtoPlanarF(&src, &dst, vImage_Flags(kvImageNoFlags))
            }
        }
        return floats
    }
}
