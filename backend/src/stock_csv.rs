//! Stock CSV (Power Tools, Cardmarket, CardTrader) → locations of the copies
//! already in the inventory. Same rules as the Pokoin Power Tools import:
//! location styles (`as_is`, `trailing_stack`, `structured`), auto-detection,
//! and the name + collector number + condition/language/reverse/1st-edition key
//! with the set title as a soft hint. Matching runs in memory and the new
//! locations are written with one statement.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::auth::Session;
use crate::error::ApiError;
use crate::AppState;

const MAX_ROWS: usize = 200_000;
const MAX_QUANTITY: i64 = 10_000;

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/inventory/locations/csv", post(post_locations_csv))
}

// ---------------------------------------------------------------- text helpers

pub fn clean_text(value: &str, max: usize) -> String {
    let replaced: String = value
        .chars()
        .map(|c| if (c as u32) < 0x20 || c as u32 == 0x7f { ' ' } else { c })
        .collect();
    replaced.trim().chars().take(max).collect()
}

fn truthy(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "y" | "x")
}

fn clamp_int(value: &str, min: i64, max: i64, fallback: i64) -> i64 {
    match value.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => (n.trunc() as i64).clamp(min, max),
        _ => fallback,
    }
}

/// Lowercase, accents stripped, only `[a-z0-9]`.
pub fn compact_key(value: &str) -> String {
    clean_text(value, 240)
        .to_lowercase()
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// `069/101`, `69/101`, `Rare | 070/131` and bare `69` compare equal.
pub fn compact_collector(value: &str) -> String {
    static RARITY: OnceLock<Regex> = OnceLock::new();
    static SLASH: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    static ZEROS: OnceLock<Regex> = OnceLock::new();
    let raw = clean_text(value, 40).to_lowercase();
    if raw.is_empty() {
        return raw;
    }
    // Rarity before a bar ("Rare | 070/131"); a label after it ("043 | Stamp") keeps the number.
    let stripped = re(&RARITY, r"^.*\|\s*").replace(&raw, "").into_owned();
    let raw = if stripped.chars().any(|c| c.is_ascii_digit()) {
        stripped
    } else {
        raw.split('|').next().unwrap_or("").trim().to_string()
    };
    // "181/214" anywhere: catalogs prefix variants ("Pokémon League 181/214").
    if let Some(c) = re(&SLASH, r"(?:^|[^0-9a-z])0*(\d+)\s*/\s*0*\d+").captures(&raw) {
        return c[1].to_string();
    }
    if let Some(c) = re(&BARE, r"^(?:no\.?\s*)?0*(\d+)\b").captures(&raw) {
        return c[1].to_string();
    }
    re(&ZEROS, r"^0+(\d)").replace(&raw, "$1").into_owned()
}

// ---------------------------------------------------------------- mappings

/// Cardmarket / Power Tools scale → Card Rails conditions.
pub fn condition_from_cm(raw: &str) -> &'static str {
    match clean_text(raw, 40).to_lowercase().as_str() {
        "mt" | "mint" | "nm" | "near mint" => "NM",
        "ex" | "excellent" | "sp" | "slightly played" => "SP",
        "gd" | "good" | "mp" | "moderately played" | "lp" | "lightly played" => "MP",
        "pl" | "played" | "hp" | "heavily played" => "PL",
        "po" | "poor" => "PO",
        _ => "NM",
    }
}

/// CardTrader English labels → Card Rails conditions (Mint stays Mint).
pub fn condition_from_ct(raw: &str) -> &'static str {
    match clean_text(raw, 40).to_lowercase().as_str() {
        "mint" => "M",
        "near mint" | "nm" => "NM",
        "slightly played" | "sp" => "SP",
        "moderately played" | "mp" | "lightly played" | "lp" => "MP",
        "played" | "heavily played" | "hp" | "pl" => "PL",
        "poor" | "po" => "PO",
        other => condition_from_cm(other),
    }
}

/// Language names or codes (`Italian`, `it`, `jp`, `kr`, `zh-CN`) → codes.
/// `None` for languages the inventory doesn't track.
pub fn language_code(raw: &str) -> Option<&'static str> {
    let key = clean_text(raw, 40).to_lowercase();
    Some(match key.as_str() {
        "" | "english" | "en" => "EN",
        "italian" | "it" => "IT",
        "german" | "de" => "DE",
        "french" | "fr" => "FR",
        "spanish" | "es" => "ES",
        "portuguese" | "pt" => "PT",
        "japanese" | "jp" | "ja" => "JP",
        "korean" | "ko" | "kr" => "KO",
        k if k == "chinese" || k.starts_with("zh") || k.starts_with("chinese") => "ZH",
        _ => return None,
    })
}

fn facet_condition(condition: &str) -> &'static str {
    match condition.to_uppercase().as_str() {
        "M" | "MT" | "NM" | "" => "NM",
        "SP" | "LP" | "EX" => "SP",
        "MP" | "GD" => "MP",
        "PL" | "HP" => "PL",
        "PO" | "POOR" => "POOR",
        _ => "NM",
    }
}

/// Copy facts the match key is built from (one CSV row or one inventory copy).
#[derive(Debug, Clone, Default)]
pub struct MatchFacts {
    pub name: String,
    pub collector: String,
    pub set: String,
    pub condition: String,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
}

/// `name|collector|condition|language|reverse|1st` — no card id, so Power Tools
/// rows (Cardmarket ids) meet CardTrader blueprints.
pub fn stock_match_key(row: &MatchFacts) -> Option<String> {
    let name = compact_key(&row.name);
    if name.is_empty() {
        return None;
    }
    let language = if row.language.is_empty() { "EN".to_string() } else { row.language.to_uppercase() };
    Some(format!(
        "{name}|{}|{}|{language}|{}|{}",
        compact_collector(&row.collector),
        facet_condition(&row.condition),
        u8::from(row.reverse),
        u8::from(row.first_edition),
    ))
}

// ---------------------------------------------------------------- locations

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLocation {
    pub box_label: String,
    pub stack: i64,
    pub position: i64,
    pub structured: bool,
    pub has_position: bool,
}

impl ParsedLocation {
    fn bare(text: &str) -> Self {
        ParsedLocation { box_label: text.to_string(), stack: 1, position: 1, structured: false, has_position: false }
    }
}

/// `box·2·5`, `box·3`, trailing ` #3`, or a bare box.
pub fn parse_location(raw: &str) -> ParsedLocation {
    static MID: OnceLock<Regex> = OnceLock::new();
    static DASH: OnceLock<Regex> = OnceLock::new();
    static HASH: OnceLock<Regex> = OnceLock::new();
    let text = clean_text(raw, 120);
    if text.is_empty() {
        return ParsedLocation::bare("");
    }
    if let Some(c) = re(&MID, r"^(.+?)[·•](\d+)(?:[·•](\d+))?$").captures(&text) {
        return ParsedLocation {
            box_label: clean_text(&c[1], 64),
            stack: clamp_int(&c[2], 1, 9999, 1),
            position: c.get(3).map_or(1, |m| clamp_int(m.as_str(), 1, 9999, 1)),
            structured: true,
            has_position: c.get(3).is_some(),
        };
    }
    if let Some(c) = re(&DASH, r"^(.+?)[\s_-]+(\d+)[\s_-]+(\d+)$").captures(&text) {
        if !c[1].chars().all(|ch| ch.is_ascii_digit()) {
            // Ambiguous with box names like "FUOCOBOMBA 006 - 16": keep it whole.
            return ParsedLocation::bare(&text);
        }
    }
    if let Some(c) = re(&HASH, r"^(.+?)\s*#\s*(\d+)$").captures(&text) {
        return ParsedLocation {
            box_label: clean_text(&c[1], 64),
            stack: clamp_int(&c[2], 1, 9999, 1),
            position: 1,
            structured: true,
            has_position: false,
        };
    }
    ParsedLocation::bare(&text)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LocationParse {
    AsIs,
    TrailingStack,
    Structured,
}

impl LocationParse {
    pub fn name(self) -> &'static str {
        match self {
            LocationParse::AsIs => "as_is",
            LocationParse::TrailingStack => "trailing_stack",
            LocationParse::Structured => "structured",
        }
    }
}

/// - as_is: the whole CSV location is the box label
/// - trailing_stack: the last ` - N` / ` N` is the stack, the rest is the box
/// - structured: already `box·stack` (or `box·stack·pos`)
pub fn parse_powertools_location(raw: &str, mode: LocationParse) -> ParsedLocation {
    static STRUCT: OnceLock<Regex> = OnceLock::new();
    static DASH: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();
    let text = clean_text(raw, 120);
    if text.is_empty() {
        return ParsedLocation::bare("");
    }
    if mode == LocationParse::Structured || re(&STRUCT, r"[·•]\d+").is_match(&text) {
        return parse_location(&text);
    }
    if mode == LocationParse::TrailingStack {
        let stacked = |box_label: &str, stack: &str| ParsedLocation {
            box_label: clean_text(box_label, 64),
            stack: clamp_int(stack, 1, 9999, 1),
            position: 1,
            structured: true,
            has_position: false,
        };
        if let Some(c) = re(&DASH, r"^(.+?)\s+-\s+(\d+)$").captures(&text) {
            return stacked(&c[1], &c[2]);
        }
        if let Some(c) = re(&SPACE, r"^(.+?)[\s_]+(\d+)$").captures(&text) {
            if c[1].chars().any(|ch| ch.is_ascii_alphabetic()) {
                return stacked(&c[1], &c[2]);
            }
        }
    }
    ParsedLocation::bare(&text)
}

pub struct LocationStyle {
    pub parse: LocationParse,
    pub examples: Vec<String>,
    pub structured: usize,
    pub trailing: usize,
    pub as_is: usize,
}

/// Infer the style from the seller's own locations (examples only from the file).
pub fn detect_location_style<'a>(locations: impl Iterator<Item = &'a str>) -> LocationStyle {
    static STRUCT: OnceLock<Regex> = OnceLock::new();
    static DASH: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();
    let (mut structured, mut trailing, mut as_is) = (0, 0, 0);
    let mut examples: Vec<String> = Vec::new();
    for raw in locations {
        let text = clean_text(raw, 120);
        if text.is_empty() {
            continue;
        }
        if examples.len() < 6 && !examples.contains(&text) {
            examples.push(text.clone());
        }
        if re(&STRUCT, r"[·•#]\d+").is_match(&text) {
            structured += 1;
        } else if re(&DASH, r"^.+?\s+-\s+\d+$").is_match(&text)
            || (re(&SPACE, r"^.+?[\s_]+\d+$").is_match(&text)
                && text.chars().any(|c| c.is_ascii_alphabetic() || ('À'..='ÿ').contains(&c)))
        {
            trailing += 1;
        } else {
            as_is += 1;
        }
    }
    let parse = if structured > 0 && structured >= trailing && structured >= as_is {
        LocationParse::Structured
    } else if trailing > as_is {
        LocationParse::TrailingStack
    } else {
        LocationParse::AsIs
    };
    LocationStyle { parse, examples, structured, trailing, as_is }
}

/// Pokoin's printed form: `box`, `box·stack`, or `box·stack·pos` when numbered.
pub fn format_location(box_label: &str, stack: i64, position: i64, numbered: bool, include_stack: bool) -> String {
    if box_label.is_empty() {
        return String::new();
    }
    if numbered {
        format!("{box_label}·{stack}·{position}")
    } else if include_stack || stack > 1 {
        format!("{box_label}·{stack}")
    } else {
        box_label.to_string()
    }
}

// ---------------------------------------------------------------- CSV

/// RFC-4180-ish, like the Pokoin parser (BOM, quotes, CRLF, blank lines skipped).
/// A header with semicolons and no commas switches the separator.
pub fn parse_csv(text: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let src = text.strip_prefix('\u{feff}').unwrap_or(text);
    let first_line = src.lines().next().unwrap_or("");
    let sep = if !first_line.contains(',') && first_line.contains(';') { ';' } else { ',' };
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = src.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cell.push(ch);
            }
            continue;
        }
        match ch {
            '"' => quoted = true,
            c if c == sep => row.push(std::mem::take(&mut cell)),
            '\n' | '\r' => {
                if ch == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut cell));
                if row.iter().any(|c| !c.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => cell.push(ch),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        if row.iter().any(|c| !c.is_empty()) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let headers = rows.remove(0).iter().map(|h| clean_text(h, 80)).collect();
    (headers, rows)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
    PowerTools,
    Cardmarket,
    CardTrader,
}

impl Format {
    fn name(self) -> &'static str {
        match self {
            Format::PowerTools => "powertools",
            Format::Cardmarket => "cardmarket",
            Format::CardTrader => "cardtrader",
        }
    }
}

pub fn detect_format(headers: &[String]) -> Option<Format> {
    let has = |h: &str| headers.iter().any(|x| x == h);
    if has("cardmarketId") && has("finishType") {
        Some(Format::PowerTools)
    } else if has("blueprint_id") || has("price_cents") {
        Some(Format::CardTrader)
    } else if has("idProduct") || (has("expansion") && has("isFoil")) {
        Some(Format::Cardmarket)
    } else if has("cardmarketId") {
        Some(Format::PowerTools)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct StockRow {
    pub facts: MatchFacts,
    pub quantity: i64,
    pub location: String,
    pub ct_product_id: Option<i64>,
}

fn finish_is_reverse(finish_type: &str, is_reverse_holo: &str) -> bool {
    let finish = clean_text(finish_type, 40);
    truthy(is_reverse_holo) || finish.to_lowercase().contains("reverse")
}

pub fn normalize_row(format: Format, headers: &[String], cols: &[String]) -> StockRow {
    let get = |name: &str| -> &str {
        headers
            .iter()
            .position(|h| h == name)
            .and_then(|i| cols.get(i))
            .map_or("", String::as_str)
    };
    let language = |raw: &str| language_code(raw).unwrap_or("EN").to_string();
    match format {
        Format::PowerTools => StockRow {
            facts: MatchFacts {
                name: clean_text(get("name"), 240),
                collector: clean_text(get("cn"), 40),
                set: clean_text(get("set"), 240),
                condition: condition_from_cm(get("condition")).to_string(),
                language: language(get("language")),
                reverse: finish_is_reverse(get("finishType"), get("isReverseHolo")),
                first_edition: truthy(get("isFirstEd")),
            },
            quantity: clamp_int(get("quantity"), 1, MAX_QUANTITY, 1),
            location: clean_text(get("location"), 120),
            ct_product_id: None,
        },
        Format::Cardmarket => StockRow {
            facts: MatchFacts {
                name: clean_text(get("name"), 240),
                collector: clean_text(get("number"), 40),
                set: clean_text(get("expansion"), 240),
                condition: condition_from_cm(get("condition")).to_string(),
                language: language(get("language")),
                reverse: truthy(get("isReverseHolo")),
                first_edition: truthy(get("isFirstEd")),
            },
            quantity: clamp_int(get("quantity"), 1, MAX_QUANTITY, 1),
            location: clean_text(get("location"), 120),
            ct_product_id: None,
        },
        Format::CardTrader => StockRow {
            facts: MatchFacts {
                name: clean_text(get("name"), 240),
                collector: clean_text(get("number"), 40),
                set: clean_text(get("expansion"), 240),
                condition: condition_from_ct(get("condition")).to_string(),
                language: language(get("language")),
                reverse: truthy(get("reverse")) || clean_text(get("foil"), 40).eq_ignore_ascii_case("reverse"),
                first_edition: truthy(get("first_edition")),
            },
            quantity: clamp_int(get("quantity"), 1, MAX_QUANTITY, 1),
            location: clean_text(get("location"), 120),
            ct_product_id: get("product_id").trim().parse().ok(),
        },
    }
}

// ---------------------------------------------------------------- assignment

#[derive(Debug, Clone)]
pub struct Slot {
    pub box_label: String,
    pub stack: i64,
    /// Absolute position in the box: `(stack - 1) * stackSize + place in stack`.
    pub position: i64,
    pub end: i64,
    pub label: String,
}

pub struct Assignment {
    pub slots: Vec<Option<Slot>>,
    pub stack_size: i64,
    pub suggested_stack_size: i64,
    /// (label, box, stack, copies), busiest first.
    pub occupancy: Vec<(String, String, i64, i64)>,
}

/// Power Tools rows → box·stack slots in file order. The number after the box
/// is the stack index, not its capacity. Without `numbered`, every copy of a
/// stack shares its first slot (Power Tools never says where in the stack);
/// with it, copies fill the stack in file order and spill into the next one.
pub fn assign_locations(rows: &[StockRow], mode: LocationParse, stack_size: Option<i64>, numbered: bool) -> Assignment {
    let parsed: Vec<Option<ParsedLocation>> = rows
        .iter()
        .map(|row| {
            let p = parse_powertools_location(&row.location, mode);
            (!p.box_label.is_empty()).then_some(p)
        })
        .collect();

    let mut counts: HashMap<(String, i64), i64> = HashMap::new();
    let mut order: Vec<(String, i64)> = Vec::new();
    for (row, p) in rows.iter().zip(&parsed) {
        let Some(p) = p else { continue };
        let key = (p.box_label.clone(), p.stack.max(1));
        let entry = counts.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            0
        });
        *entry += row.quantity;
    }
    let suggested = counts.values().copied().max().unwrap_or(1).max(1);
    let size = stack_size.filter(|s| *s > 0).unwrap_or(suggested);

    let mut filled: HashMap<(String, i64), i64> = HashMap::new();
    let slots = rows
        .iter()
        .zip(&parsed)
        .map(|(row, p)| {
            let p = p.as_ref()?;
            let stack = p.stack.max(1);
            let include_stack = p.structured || mode == LocationParse::TrailingStack || stack > 1;
            let (position, label) = if numbered {
                let start = if p.has_position {
                    (stack - 1) * size + p.position
                } else {
                    let used = filled.entry((p.box_label.clone(), stack)).or_insert(0);
                    let start = (stack - 1) * size + *used + 1;
                    *used += row.quantity;
                    start
                };
                let (s, place) = (1 + (start - 1) / size, 1 + (start - 1) % size);
                (start, format_location(&p.box_label, s, place, true, true))
            } else {
                ((stack - 1) * size + 1, format_location(&p.box_label, stack, 1, false, include_stack))
            };
            Some(Slot {
                box_label: p.box_label.clone(),
                stack: 1 + (position - 1) / size,
                position,
                end: position + row.quantity - 1,
                label,
            })
        })
        .collect();

    let mut occupancy: Vec<(String, String, i64, i64)> = order
        .into_iter()
        .map(|(b, s)| {
            let n = counts[&(b.clone(), s)];
            let label = if s > 1 || mode == LocationParse::TrailingStack { format!("{b}·{s}") } else { b.clone() };
            (label, b, s, n)
        })
        .collect();
    occupancy.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.0.cmp(&b.0)));
    Assignment { slots, stack_size: size, suggested_stack_size: suggested, occupancy }
}

// ---------------------------------------------------------------- matching

pub struct Copy {
    pub seq: i64,
    pub ct_product_id: Option<i64>,
    pub facts: MatchFacts,
}

/// Pair each copy with one CSV row: the CardTrader product id when the file has
/// it, else the stock key, preferring a row of the same set. Each row is used once.
/// Returns, per copy, the index of its CSV row.
pub fn match_rows(rows: &[StockRow], copies: &[Copy]) -> Vec<Option<usize>> {
    let mut by_product: HashMap<i64, usize> = HashMap::new();
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(id) = row.ct_product_id {
            by_product.entry(id).or_insert(i);
        }
        if let Some(key) = stock_match_key(&row.facts) {
            by_key.entry(key).or_default().push(i);
        }
    }
    let mut used = vec![false; rows.len()];
    let mut set_cache: HashMap<usize, String> = HashMap::new();
    copies
        .iter()
        .map(|copy| {
            if let Some(i) = copy.ct_product_id.and_then(|id| by_product.get(&id).copied()) {
                if !used[i] {
                    used[i] = true;
                    return Some(i);
                }
            }
            let bucket = by_key.get_mut(&stock_match_key(&copy.facts)?)?;
            bucket.retain(|i| !used[*i]);
            if bucket.is_empty() {
                return None;
            }
            let hint = compact_key(&copy.facts.set);
            let pick = if hint.is_empty() {
                0
            } else {
                bucket
                    .iter()
                    .position(|i| *set_cache.entry(*i).or_insert_with(|| compact_key(&rows[*i].facts.set)) == hint)
                    .unwrap_or(0)
            };
            let i = bucket.remove(pick);
            used[i] = true;
            Some(i)
        })
        .collect()
}

// ---------------------------------------------------------------- endpoint

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocationsRequest {
    csv: String,
    #[serde(default)]
    location_parse: Option<String>,
    #[serde(default)]
    stack_size: Option<i64>,
    #[serde(default)]
    numbered_in_stack: bool,
    /// false = preview only.
    #[serde(default)]
    apply: bool,
}

#[derive(sqlx::FromRow)]
struct CopyRow {
    seq: i64,
    ct_product_id: Option<i64>,
    name: String,
    number: String,
    set_name: String,
    condition: String,
    language: String,
    printing: String,
    first_edition: bool,
}

/// `POST /v1/inventory/locations/csv`: `{csv, locationParse?, stackSize?,
/// numberedInStack?, apply}` → matched copies get the file's locations.
async fn post_locations_csv(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<LocationsRequest>,
) -> Result<Response, ApiError> {
    let started = Instant::now();
    let (headers, records) = parse_csv(&body.csv);
    let format = detect_format(&headers).ok_or_else(|| {
        ApiError::bad_request("Unrecognized CSV format. Use a Power Tools, Cardmarket or CardTrader export.")
    })?;
    if records.is_empty() || records.len() > MAX_ROWS {
        return Err(ApiError::bad_request("The file has no rows, or more than 200,000."));
    }
    let rows: Vec<StockRow> = records.iter().map(|cols| normalize_row(format, &headers, cols)).collect();

    let style = detect_location_style(rows.iter().map(|r| r.location.as_str()));
    let mode = match body.location_parse.as_deref().unwrap_or("auto") {
        "as_is" => LocationParse::AsIs,
        "trailing_stack" => LocationParse::TrailingStack,
        "structured" => LocationParse::Structured,
        _ => style.parse,
    };
    let assignment = assign_locations(&rows, mode, body.stack_size, body.numbered_in_stack);
    let parse_ms = started.elapsed().as_millis();

    let copies: Vec<CopyRow> = sqlx::query_as(
        "SELECT seq, ct_product_id, name, number, set_name, condition, language, printing, first_edition \
         FROM inventory_items WHERE account_id = $1 ORDER BY seq",
    )
    .bind(session.account_id)
    .fetch_all(&state.pool)
    .await?;
    let load_ms = started.elapsed().as_millis() - parse_ms;

    let copies: Vec<Copy> = copies
        .into_iter()
        .map(|c| Copy {
            seq: c.seq,
            ct_product_id: c.ct_product_id,
            facts: MatchFacts {
                name: c.name,
                collector: c.number,
                set: c.set_name,
                condition: c.condition,
                language: c.language,
                reverse: c.printing.eq_ignore_ascii_case("reverse holo"),
                first_edition: c.first_edition,
            },
        })
        .collect();
    let pairs = match_rows(&rows, &copies);
    let match_ms = started.elapsed().as_millis() - parse_ms - load_ms;

    let mut seqs = Vec::new();
    let mut locations = Vec::new();
    let mut row_used = vec![false; rows.len()];
    let mut without_location = 0usize;
    for (copy, pair) in copies.iter().zip(&pairs) {
        let Some(i) = pair else { continue };
        row_used[*i] = true;
        match &assignment.slots[*i] {
            Some(slot) => {
                seqs.push(copy.seq);
                locations.push(
                    json!({
                        "box": slot.box_label,
                        "row": slot.stack.to_string(),
                        "position": slot.position,
                        "end": slot.end,
                        "stackSize": assignment.stack_size,
                        "label": slot.label,
                    })
                    .to_string(),
                );
            }
            None => without_location += 1,
        }
    }
    let csv_only: Vec<Value> = rows
        .iter()
        .zip(&row_used)
        .filter(|(_, used)| !**used)
        .take(50)
        .map(|(r, _)| json!({ "name": r.facts.name, "number": r.facts.collector, "set": r.facts.set, "condition": r.facts.condition, "language": r.facts.language, "location": r.location }))
        .collect();
    let csv_only_count = row_used.iter().filter(|u| !**u).count();

    let mut revision = None;
    let mut write_ms = 0;
    if body.apply && !seqs.is_empty() {
        let write_started = Instant::now();
        let mut tx = state.pool.begin().await?;
        sqlx::query(
            "UPDATE inventory_items i SET location = u.loc::jsonb, version = i.version + 1, updated_at = now() \
             FROM UNNEST($2::bigint[], $3::text[]) AS u(seq, loc) \
             WHERE i.account_id = $1 AND i.seq = u.seq",
        )
        .bind(session.account_id)
        .bind(&seqs)
        .bind(&locations)
        .execute(&mut *tx)
        .await?;
        let (rev,): (i64,) = sqlx::query_as(
            "UPDATE workspaces SET revision = revision + 1, updated_at = now() WHERE account_id = $1 RETURNING revision",
        )
        .bind(session.account_id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        revision = Some(rev);
        write_ms = write_started.elapsed().as_millis();
    }

    let overflows: Vec<Value> = match body.stack_size {
        Some(size) if size > 0 => assignment
            .occupancy
            .iter()
            .filter(|o| o.3 > size)
            .map(|o| json!({ "label": o.0, "copies": o.3, "stackSize": size }))
            .collect(),
        _ => Vec::new(),
    };

    Ok((
        StatusCode::OK,
        Json(json!({
            "format": format.name(),
            "rows": rows.len(),
            "locationDetection": {
                "locationParse": style.parse.name(),
                "examples": style.examples,
                "counts": { "structured": style.structured, "trailing": style.trailing, "asIs": style.as_is },
            },
            "locationParse": mode.name(),
            "stackSize": assignment.stack_size,
            "suggestedStackSize": assignment.suggested_stack_size,
            "numberedInStack": body.numbered_in_stack,
            "occupancy": assignment.occupancy.iter().take(50)
                .map(|o| json!({ "label": o.0, "box": o.1, "stack": o.2, "copies": o.3 })).collect::<Vec<_>>(),
            "overflows": overflows,
            "matched": seqs.len(),
            "matchedWithoutLocation": without_location,
            "inventoryOnly": copies.len() - pairs.iter().filter(|p| p.is_some()).count(),
            "csvOnly": csv_only_count,
            "csvOnlySample": csv_only,
            "applied": revision.is_some(),
            "revision": revision,
            "timings": { "parseMs": parse_ms, "loadMs": load_ms, "matchMs": match_ms, "writeMs": write_ms },
        })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_numbers_compare_like_pokoin() {
        assert_eq!(compact_collector("069/101"), "69");
        assert_eq!(compact_collector("Rare | 070/131"), "70");
        assert_eq!(compact_collector("69"), "69");
        assert_eq!(compact_collector("0"), "0");
        assert_eq!(compact_collector("OP05-006"), "op05-006");
        assert_eq!(compact_collector("SWSH050"), "swsh050");
        assert_eq!(compact_collector("Pokémon League 181/214"), "181");
        assert_eq!(compact_collector("Non-Holo | B&B Kit 189/198"), "189");
        assert_eq!(compact_collector("No.220"), "220");
        assert_eq!(compact_collector("043 | Holiday Snowflake Stamp"), "43");
        assert_eq!(compact_collector("TG05/TG30"), "tg05/tg30");
        assert_eq!(compact_key("Pokémon  Ex-Δ"), "pokemonex");
    }

    #[test]
    fn locations_follow_the_power_tools_modes() {
        let p = parse_powertools_location("FUOCOBOMBA 006 - 16", LocationParse::AsIs);
        assert_eq!((p.box_label.as_str(), p.stack, p.structured), ("FUOCOBOMBA 006 - 16", 1, false));
        let p = parse_powertools_location("FUOCOBOMBA 006 - 16", LocationParse::TrailingStack);
        assert_eq!((p.box_label.as_str(), p.stack, p.structured), ("FUOCOBOMBA 006", 16, true));
        let p = parse_powertools_location("Binder 3", LocationParse::TrailingStack);
        assert_eq!((p.box_label.as_str(), p.stack), ("Binder", 3));
        let p = parse_powertools_location("A01·2·5", LocationParse::AsIs);
        assert_eq!((p.box_label.as_str(), p.stack, p.position, p.has_position), ("A01", 2, 5, true));
        let p = parse_location("Box #3");
        assert_eq!((p.box_label.as_str(), p.stack), ("Box", 3));
        let p = parse_location("1 2 3");
        assert_eq!((p.box_label.as_str(), p.stack), ("1 2 3", 1));

        let style = detect_location_style(["FUOCO 006 - 16", "FUOCO 006 - 17", "SCATOLA"].into_iter());
        assert_eq!(style.parse, LocationParse::TrailingStack);
        assert_eq!(style.examples.len(), 3);
        let style = detect_location_style(["A·1", "B·2", "C"].into_iter());
        assert_eq!(style.parse, LocationParse::Structured);
        let style = detect_location_style(["Scatola rossa", "Scatola blu"].into_iter());
        assert_eq!(style.parse, LocationParse::AsIs);
    }

    fn row(name: &str, cn: &str, set: &str, qty: i64, location: &str) -> StockRow {
        StockRow {
            facts: MatchFacts {
                name: name.into(),
                collector: cn.into(),
                set: set.into(),
                condition: "NM".into(),
                language: "IT".into(),
                ..Default::default()
            },
            quantity: qty,
            location: location.into(),
            ct_product_id: None,
        }
    }

    #[test]
    fn numbered_stacks_fill_in_file_order_and_spill() {
        let rows = vec![
            row("A", "1", "", 2, "BOX - 1"),
            row("B", "2", "", 1, "BOX - 1"),
            row("C", "3", "", 1, "BOX - 2"),
            row("D", "4", "", 1, ""),
        ];
        let a = assign_locations(&rows, LocationParse::TrailingStack, Some(2), true);
        let slot = |i: usize| a.slots[i].as_ref().map(|s| (s.position, s.end, s.stack, s.label.clone()));
        assert_eq!(slot(0), Some((1, 2, 1, "BOX·1·1".into())));
        assert_eq!(slot(1), Some((3, 3, 2, "BOX·2·1".into())), "spills into the next stack");
        assert_eq!(slot(2), Some((3, 3, 2, "BOX·2·1".into())));
        assert_eq!(slot(3), None);
        assert_eq!(a.suggested_stack_size, 3);

        let a = assign_locations(&rows, LocationParse::TrailingStack, None, false);
        assert_eq!(a.stack_size, 3);
        let s = a.slots[1].as_ref().unwrap();
        assert_eq!((s.position, s.label.as_str()), (1, "BOX·1"));
        let s = a.slots[2].as_ref().unwrap();
        assert_eq!((s.position, s.stack, s.label.as_str()), (4, 2, "BOX·2"));
    }

    #[test]
    fn matching_uses_key_prefers_set_and_consumes_rows() {
        let rows = vec![
            row("Pikachu", "025/165", "Base", 1, "X"),
            row("Pikachu", "25", "151", 1, "Y"),
            row("Mew", "151", "151", 1, "Z"),
        ];
        let copy = |seq, name: &str, number: &str, set: &str| Copy {
            seq,
            ct_product_id: None,
            facts: MatchFacts { name: name.into(), collector: number.into(), set: set.into(), condition: "M".into(), language: "IT".into(), ..Default::default() },
        };
        let copies = vec![
            copy(1, "Pikachu", "Rare | 025/165", "151"),
            copy(2, "Pikachu", "25", "Other"),
            copy(3, "Pikachu", "25", ""),
            copy(4, "Mew", "151/165", "151"),
        ];
        assert_eq!(match_rows(&rows, &copies), vec![Some(1), Some(0), None, Some(2)]);
    }

    #[test]
    fn csv_parser_handles_quotes_bom_and_semicolons() {
        let (h, r) = parse_csv("\u{feff}name,location\r\n\"Mew, \"\"ex\"\"\",A\r\n\r\nPika,B");
        assert_eq!(h, vec!["name", "location"]);
        assert_eq!(r, vec![vec!["Mew, \"ex\"".to_string(), "A".into()], vec!["Pika".into(), "B".into()]]);
        let (h, r) = parse_csv("name;location\nMew;A\n");
        assert_eq!(h, vec!["name", "location"]);
        assert_eq!(r[0], vec!["Mew".to_string(), "A".into()]);
    }

    #[test]
    fn power_tools_rows_normalize() {
        let headers: Vec<String> = ["cardmarketId", "quantity", "name", "set", "setCode", "cn", "condition", "language", "isFirstEd", "isReverseHolo", "isSigned", "finishType", "price", "comment", "location"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(detect_format(&headers), Some(Format::PowerTools));
        let cols: Vec<String> = ["123", "2", "Pikachu", "151", "MEW", "025", "EX", "Italian", "", "", "", "reverseHolo", "1.5", "", "BOX - 3"]
            .iter().map(|s| s.to_string()).collect();
        let r = normalize_row(Format::PowerTools, &headers, &cols);
        assert_eq!((r.quantity, r.facts.condition.as_str(), r.facts.language.as_str(), r.facts.reverse), (2, "SP", "IT", true));
        assert_eq!(stock_match_key(&r.facts).unwrap(), "pikachu|25|SP|IT|1|0");
    }
}
