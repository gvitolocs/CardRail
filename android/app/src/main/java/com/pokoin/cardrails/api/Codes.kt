package com.pokoin.cardrails.api

/**
 * Numeric dictionaries shared with the Card Rails API (`GET /v1/dictionary`), the
 * iPhone app and the browser. Compact inventory rows and compact imports use these
 * codes instead of repeating strings for every copy. Append-only: never renumber.
 */
object Codes {
    const val VERSION = 1

    /** Code = index + 1. */
    val games = listOf(
        "pokemon", "magic", "yugioh", "one_piece", "lorcana", "riftbound", "vanguard",
        "flesh_and_blood", "dragon_ball_super", "digimon", "star_wars", "union_arena",
        "gundam", "sorcery", "palworld", "cyberpunk",
    )
    /** L1 English, L2 Italian, … L5 Japanese. */
    val languages = listOf("EN", "IT", "FR", "DE", "JP", "ES", "PT", "ZH", "KO")
    val conditions = listOf("M", "NM", "SP", "MP", "PL", "PO")
    /** Finishes outside this list travel as plain text. */
    val printings = listOf("Standard", "Holo", "Reverse Holo")

    const val FLAG_FIRST_EDITION = 1
    const val FLAG_SIGNED = 2
    const val FLAG_ALTERED = 4
    const val FLAG_COLLECTION = 8
    const val FLAG_IMPORTED = 16

    fun code(value: String, table: List<String>): Int? = table.indexOf(value).takeIf { it >= 0 }?.plus(1)
    fun value(code: Int, table: List<String>): String? = table.getOrNull(code - 1)
}
