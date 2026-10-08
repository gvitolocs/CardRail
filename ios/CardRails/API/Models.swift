import Foundation

struct Account: Codable, Equatable {
    let id: String
    let email: String
    let createdAt: String?
}

struct AuthResponse: Codable {
    let account: Account
    let token: String
}

struct InventoryIdentity: Codable, Equatable {
    let game: String
    let name: String
    let setName: String
    let number: String
    let publicId: String
    let cardtraderBlueprintId: String
}

struct InventoryLocation: Codable, Equatable {
    let box: String?
    let row: String?
    let position: Int?
    let end: Int?
    let stackSize: Int?
}

struct ScanPhoto: Codable, Equatable {
    let id: String
    let sha256: String
    let bytes: Int
    let capturedAt: String?
    let role: String
    let url: String
}

struct InventoryItem: Codable, Equatable, Identifiable {
    let id: String
    let identity: InventoryIdentity
    let art: String
    let language: String
    let condition: String
    let printing: String
    let firstEdition: Bool
    let signed: Bool
    let altered: Bool
    let purpose: String
    let quantity: Int
    let price: Double
    let currency: String
    let source: String
    let location: InventoryLocation?
    let scanPhoto: ScanPhoto?
    let version: Int
    let createdAt: String?
    let updatedAt: String?
}

struct ScanSettings: Codable, Equatable {
    var game: String
    var language: String
    var condition: String
    var printing: String
    var firstEdition: Bool
    var signed: Bool
    var altered: Bool
    var storageLabel: String
    var stackSize: Int?
    var stack: Int
    var startPosition: Int
    var mergeRepeats: Bool
    var paused: Bool
    var locationConfigured: Bool

    static let `default` = ScanSettings(
        game: "pokemon",
        language: "EN",
        condition: "NM",
        printing: "Standard",
        firstEdition: false,
        signed: false,
        altered: false,
        storageLabel: "",
        stackSize: nil,
        stack: 1,
        startPosition: 1,
        mergeRepeats: true,
        paused: false,
        locationConfigured: false
    )
}

/// Partial update for `PUT /v1/inventory/settings`; nil fields are omitted.
struct ScanSettingsUpdate: Codable {
    var game: String?
    var language: String?
    var condition: String?
    var printing: String?
    var firstEdition: Bool?
    var signed: Bool?
    var altered: Bool?
    var storageLabel: String?
    var stackSize: Int?
    var stack: Int?
    var startPosition: Int?
    var mergeRepeats: Bool?
    var paused: Bool?
}

struct InventoryResponse: Codable {
    let items: [InventoryItem]
    let scanSettings: ScanSettings
    let revision: Int
}

struct SettingsResponse: Codable {
    let scanSettings: ScanSettings
    let revision: Int
}

struct PhotoResponse: Codable {
    let id: String
    let sha256: String
    let bytes: Int
    let url: String
}

struct ScanIdentity: Codable {
    var game: String
    var name: String
    var setName: String
    var number: String
    var publicId: String
    var cardtraderBlueprintId: String
}

struct ScanCard: Codable {
    var identity: ScanIdentity
    var art: String
    var language: String
    var condition: String
    var printing: String
    var firstEdition: Bool
    var signed: Bool
    var altered: Bool
    var quantity: Int
    var price: Double
    var photoId: String?
}

struct ScanCommit: Codable {
    var idempotencyKey: String
    var intent: String
    var cards: [ScanCard]
}

struct CommitResponse: Codable {
    let items: [InventoryItem]
    let revision: Int
}

struct ItemPatch: Codable {
    var version: Int
    var quantity: Int?
    var price: Double?
    var condition: String?
    var language: String?
    var printing: String?
    var firstEdition: Bool?
    var signed: Bool?
    var altered: Bool?
}

struct ItemResponse: Codable {
    let item: InventoryItem
    let revision: Int
}

struct EmptyResponse: Codable {}

struct OkResponse: Codable {
    let ok: Bool
    let revision: Int?
}

struct APIErrorMessage: Codable {
    let error: String
}
