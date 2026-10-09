use crate::error::ApiError;

pub const LANGUAGES: [&str; 9] = ["EN", "IT", "JP", "ZH", "DE", "FR", "ES", "PT", "KO"];
pub const CONDITIONS: [&str; 6] = ["M", "NM", "SP", "MP", "PL", "PO"];
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
const UNIDENTIFIED: [&str; 2] = ["—", "Carta da identificare"];
const MAX_QUANTITY: i64 = 10_000;
const MAX_PRICE: f64 = 1_000_000.0;

const SCAN_DEFAULTS: &str = r#"{"game":"pokemon","language":"EN","condition":"NM","printing":"Standard","firstEdition":false,"signed":false,"altered":false,"storageLabel":"","stackSize":null,"stack":1,"startPosition":1,"mergeRepeats":true,"paused":false,"locationConfigured":false}"#;

pub fn scan_defaults() -> serde_json::Value {
    serde_json::from_str(SCAN_DEFAULTS).expect("scan defaults are valid JSON")
}

pub fn normalize_game(value: &str) -> Result<String, ApiError> {
    let game = value.trim();
    let game = if game == "onepiece" { "one_piece" } else { game };
    if GAMES.contains(&game) {
        Ok(game.to_string())
    } else {
        Err(ApiError::bad_request("Choose a game."))
    }
}

pub fn validate_language(value: &str) -> Result<String, ApiError> {
    let language = value.trim();
    if LANGUAGES.contains(&language) {
        Ok(language.to_string())
    } else {
        Err(ApiError::bad_request("Choose a card language."))
    }
}

pub fn validate_condition(value: &str) -> Result<String, ApiError> {
    let condition = value.trim();
    if CONDITIONS.contains(&condition) {
        Ok(condition.to_string())
    } else {
        Err(ApiError::bad_request("Choose a card condition."))
    }
}

pub fn validate_printing(value: &str) -> Result<String, ApiError> {
    let printing = value.trim();
    if printing.is_empty() || printing.chars().count() > 60 {
        return Err(ApiError::bad_request("Finish is required."));
    }
    Ok(printing.to_string())
}

pub fn validate_identity_text(value: &str) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 160 || UNIDENTIFIED.contains(&trimmed) {
        return Err(ApiError::bad_request(
            "Game, name, set and card number are required.",
        ));
    }
    Ok(trimmed.to_string())
}

pub fn truncate(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

pub fn validate_quantity(value: i64, allow_zero: bool) -> Result<i32, ApiError> {
    let minimum = if allow_zero { 0 } else { 1 };
    if value < minimum || value > MAX_QUANTITY {
        return Err(ApiError::bad_request(
            "Quantity must be a positive whole number.",
        ));
    }
    Ok(value as i32)
}

pub fn validate_price(value: f64) -> Result<f64, ApiError> {
    if !value.is_finite() || !(0.0..=MAX_PRICE).contains(&value) {
        return Err(ApiError::bad_request("Enter a valid price."));
    }
    Ok(value)
}

pub fn price_string(value: f64) -> String {
    let cents = (value * 100.0).round() as i64;
    format!("{}.{:02}", cents / 100, cents % 100)
}
