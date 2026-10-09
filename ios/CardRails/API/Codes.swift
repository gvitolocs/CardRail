import Foundation

/// Numeric dictionaries shared with the Card Rails API (`GET /v1/dictionary`), the
/// Android app and the browser. Compact inventory rows and compact imports use these
/// codes instead of repeating strings for every copy. Append-only: never renumber.
enum Codes {
    static let version = 1

    /// Code = index + 1.
    static let games = [
        "pokemon", "magic", "yugioh", "one_piece", "lorcana", "riftbound", "vanguard",
        "flesh_and_blood", "dragon_ball_super", "digimon", "star_wars", "union_arena",
        "gundam", "sorcery", "palworld", "cyberpunk",
    ]
    /// L1 English, L2 Italian, … L5 Japanese.
    static let languages = ["EN", "IT", "FR", "DE", "JP", "ES", "PT", "ZH", "KO"]
    static let conditions = ["M", "NM", "SP", "MP", "PL", "PO"]
    /// Finishes outside this list travel as plain text.
    static let printings = ["Standard", "Holo", "Reverse Holo"]

    struct Flags: OptionSet {
        let rawValue: Int
        static let firstEdition = Flags(rawValue: 1)
        static let signed = Flags(rawValue: 2)
        static let altered = Flags(rawValue: 4)
        static let collection = Flags(rawValue: 8)
        static let imported = Flags(rawValue: 16)
        static let cardtrader = Flags(rawValue: 32)
    }

    static func code(_ value: String, in table: [String]) -> Int? {
        table.firstIndex(of: value).map { $0 + 1 }
    }

    static func value(_ code: Int, in table: [String]) -> String? {
        table.indices.contains(code - 1) ? table[code - 1] : nil
    }
}
