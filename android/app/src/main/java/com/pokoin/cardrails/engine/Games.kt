package com.pokoin.cardrails.engine

data class Game(val id: String, val name: String)

object Games {
    val all = listOf(
        Game("pokemon", "Pokémon"),
        Game("magic", "Magic"),
        Game("yugioh", "Yu-Gi-Oh!"),
        Game("one_piece", "One Piece"),
        Game("lorcana", "Lorcana"),
        Game("riftbound", "Riftbound"),
        Game("vanguard", "Vanguard"),
        Game("flesh_and_blood", "Flesh and Blood"),
        Game("dragon_ball_super", "Dragon Ball Super"),
        Game("digimon", "Digimon"),
        Game("star_wars", "Star Wars Unlimited"),
        Game("union_arena", "Union Arena"),
        Game("gundam", "Gundam"),
        Game("sorcery", "Sorcery"),
        Game("palworld", "Palworld"),
        Game("cyberpunk", "Cyberpunk"),
    )

    fun name(id: String) = all.firstOrNull { it.id == id }?.name ?: id
}

object Languages {
    val all = listOf("EN", "IT", "JP", "ZH", "DE", "FR", "ES", "PT", "KO")
}

object Conditions {
    val all = listOf("NM", "SP", "MP", "PL", "PO")
}

object Finishes {
    val all = listOf("Standard", "Holo", "Reverse Holo")
}
