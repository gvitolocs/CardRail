//! Numeric dictionaries shared by the API, the apps and the browser.
//! The compact inventory and the compact import speak these codes instead of
//! repeating strings like "Near Mint" or "Italian" for every copy.
//! Codes are append-only: never renumber an entry, only add new ones.

use std::sync::OnceLock;

use serde_json::{json, Map, Value};

pub const VERSION: u32 = 1;

/// Code = index + 1.
pub const GAMES: [&str; 16] = [
    "pokemon",
    "magic",
    "yugioh",
    "one_piece",
    "lorcana",
    "riftbound",
    "vanguard",
    "flesh_and_blood",
    "dragon_ball_super",
    "digimon",
    "star_wars",
    "union_arena",
    "gundam",
    "sorcery",
    "palworld",
    "cyberpunk",
];
/// L1 English, L2 Italian, … L5 Japanese.
pub const LANGUAGES: [&str; 9] = ["EN", "IT", "FR", "DE", "JP", "ES", "PT", "ZH", "KO"];
pub const CONDITIONS: [&str; 6] = ["M", "NM", "SP", "MP", "PL", "PO"];
/// Finishes outside this list travel as plain text.
pub const PRINTINGS: [&str; 3] = ["Standard", "Holo", "Reverse Holo"];

pub const FLAG_FIRST_EDITION: i64 = 1;
pub const FLAG_SIGNED: i64 = 2;
pub const FLAG_ALTERED: i64 = 4;
pub const FLAG_COLLECTION: i64 = 8;
/// Came in through `POST /v1/inventory/import`.
pub const FLAG_IMPORTED: i64 = 16;
/// Mirrors a CardTrader product (kept in sync by the background import).
pub const FLAG_CARDTRADER: i64 = 32;

pub fn decode<'a>(table: &[&'a str], code: &Value) -> Option<&'a str> {
    let code = code.as_u64()? as usize;
    table.get(code.checked_sub(1)?).copied()
}

fn table_json(table: &[&str]) -> Value {
    let mut map = Map::new();
    for (index, value) in table.iter().enumerate() {
        map.insert((index + 1).to_string(), json!(value));
    }
    Value::Object(map)
}

/// `GET /v1/dictionary`.
pub fn dictionary() -> &'static str {
    static BODY: OnceLock<String> = OnceLock::new();
    BODY.get_or_init(|| {
        json!({
            "version": VERSION,
            "games": table_json(&GAMES),
            "languages": table_json(&LANGUAGES),
            "conditions": table_json(&CONDITIONS),
            "printings": table_json(&PRINTINGS),
            "flags": {
                "1": "firstEdition",
                "2": "signed",
                "4": "altered",
                "8": "collection",
                "16": "imported",
                "32": "cardtrader"
            }
        })
        .to_string()
    })
}

/// A Postgres `ARRAY['a','b']::text[]` literal, for `array_position` in SQL.
pub fn sql_array(table: &[&str]) -> String {
    let quoted: Vec<String> = table.iter().map(|v| format!("'{}'", v.replace('\'', "''"))).collect();
    format!("ARRAY[{}]::text[]", quoted.join(","))
}
