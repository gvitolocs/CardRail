import Foundation

struct Game: Identifiable, Hashable {
    let id: String
    let name: String
}

extension Game {
    static let all: [Game] = [
        Game(id: "pokemon", name: "Pokémon"),
        Game(id: "magic", name: "Magic"),
        Game(id: "yugioh", name: "Yu-Gi-Oh!"),
        Game(id: "one_piece", name: "One Piece"),
        Game(id: "lorcana", name: "Lorcana"),
        Game(id: "riftbound", name: "Riftbound"),
        Game(id: "vanguard", name: "Vanguard"),
        Game(id: "flesh_and_blood", name: "Flesh and Blood"),
        Game(id: "dragon_ball_super", name: "Dragon Ball Super"),
        Game(id: "digimon", name: "Digimon"),
        Game(id: "star_wars", name: "Star Wars Unlimited"),
        Game(id: "union_arena", name: "Union Arena"),
        Game(id: "gundam", name: "Gundam"),
        Game(id: "sorcery", name: "Sorcery"),
        Game(id: "palworld", name: "Palworld"),
        Game(id: "cyberpunk", name: "Cyberpunk"),
    ]
}

enum Languages {
    static let all = ["EN", "IT", "JP", "ZH", "DE", "FR", "ES", "PT", "KO"]
}

enum Conditions {
    static let all = ["NM", "SP", "MP", "PL", "PO"]

    private static let labels: [String: String] = [
        "NM": "Near Mint",
        "SP": "Slightly Played",
        "MP": "Moderately Played",
        "PL": "Played",
        "PO": "Poor",
    ]

    static func label(_ id: String) -> String {
        labels[id] ?? id
    }
}

enum Finishes {
    static let all = ["Standard", "Holo", "Reverse Holo"]
}
