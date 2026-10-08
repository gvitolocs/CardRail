import Combine
import CoreGraphics
import Foundation

struct ScanLine: Identifiable {
    let id: UUID
    var record: CardRecord
    var game: String
    var language: String
    var condition: String
    var printing: String
    var quantity: Int
    var score: Float
    var crop: CGImage?
    var firstEdition: Bool = false
    var signed: Bool = false
    var altered: Bool = false
}

/// Disk representation of a tray line; the `CGImage` crop is stored separately
/// as a JPEG file keyed by the line id.
struct PersistedScanLine: Codable, Equatable {
    let id: UUID
    let record: CardRecord
    let game: String
    let language: String
    let condition: String
    let printing: String
    let quantity: Int
    let score: Float
    let firstEdition: Bool
    let signed: Bool
    let altered: Bool
}

/// Pure scan-tray logic: dedupes repeated camera frames and builds the API
/// commit payload. Unit-tested without a camera.
@MainActor
final class ScanSession: ObservableObject {
    @Published var lines: [ScanLine] = []

    /// A card seen within this window (without leaving the frame) is ignored.
    let repeatWindow: TimeInterval

    private struct RepeatKey: Hashable {
        let id: String
        let language: String
        let condition: String
        let printing: String
    }

    private var lastAdded: [RepeatKey: Date] = [:]
    private var frameEmpty = true

    init(repeatWindow: TimeInterval = 1.5) {
        self.repeatWindow = repeatWindow
    }

    var totalCards: Int {
        lines.reduce(0) { $0 + $1.quantity }
    }

    /// Record the card the moment the frame is empty again.
    func markFrameEmpty() {
        frameEmpty = true
    }

    @discardableResult
    func add(
        record: CardRecord,
        score: Float,
        crop: CGImage?,
        settings: ScanSettings,
        at date: Date = Date()
    ) -> Bool {
        let key = RepeatKey(
            id: record.id,
            language: settings.language,
            condition: settings.condition,
            printing: settings.printing
        )

        if !frameEmpty, let last = lastAdded[key], date.timeIntervalSince(last) < repeatWindow {
            return false
        }

        lastAdded[key] = date
        frameEmpty = false

        if settings.mergeRepeats, let index = lines.firstIndex(where: {
            $0.record.id == record.id
                && $0.language == settings.language
                && $0.condition == settings.condition
                && $0.printing == settings.printing
        }) {
            lines[index].quantity += 1
            return true
        }

        lines.append(
            ScanLine(
                id: UUID(),
                record: record,
                game: settings.game,
                language: settings.language,
                condition: settings.condition,
                printing: settings.printing,
                quantity: 1,
                score: score,
                crop: crop,
                firstEdition: settings.firstEdition,
                signed: settings.signed,
                altered: settings.altered
            )
        )
        return true
    }

    func remove(id: UUID) {
        lines.removeAll { $0.id == id }
    }

    func setQuantity(id: UUID, n: Int) {
        guard n >= 1, let index = lines.firstIndex(where: { $0.id == id }) else { return }
        lines[index].quantity = n
    }

    func clear() {
        lines.removeAll()
        lastAdded.removeAll()
        frameEmpty = true
    }

    func payload(
        intent: String,
        idempotencyKey: String,
        photoIds: [UUID: String]
    ) -> ScanCommit {
        ScanCommit(
            idempotencyKey: idempotencyKey,
            intent: intent,
            cards: lines.map { line in
                ScanCard(
                    identity: ScanIdentity(
                        game: line.game,
                        name: line.record.name,
                        setName: line.record.set ?? "",
                        number: line.record.number ?? "",
                        publicId: line.record.id,
                        cardtraderBlueprintId: ""
                    ),
                    art: line.record.imageURL?.absoluteString ?? "",
                    language: line.language,
                    condition: line.condition,
                    printing: line.printing,
                    firstEdition: line.firstEdition,
                    signed: line.signed,
                    altered: line.altered,
                    quantity: line.quantity,
                    price: 0,
                    photoId: photoIds[line.id]
                )
            }
        )
    }

    // MARK: - Persistence

    /// The lines as plain values (no image), ready to write to disk.
    func persistedLines() -> [PersistedScanLine] {
        lines.map { line in
            PersistedScanLine(
                id: line.id,
                record: line.record,
                game: line.game,
                language: line.language,
                condition: line.condition,
                printing: line.printing,
                quantity: line.quantity,
                score: line.score,
                firstEdition: line.firstEdition,
                signed: line.signed,
                altered: line.altered
            )
        }
    }

    /// Replace the tray with persisted lines. `crop` supplies the restored JPEG
    /// for each line id (already-small thumbnails).
    func restore(persisted: [PersistedScanLine], crop: (UUID) -> CGImage?) {
        clear()
        lines = persisted.map { line in
            ScanLine(
                id: line.id,
                record: line.record,
                game: line.game,
                language: line.language,
                condition: line.condition,
                printing: line.printing,
                quantity: line.quantity,
                score: line.score,
                crop: crop(line.id),
                firstEdition: line.firstEdition,
                signed: line.signed,
                altered: line.altered
            )
        }
    }
}
