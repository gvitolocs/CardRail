//! CardTrader seller connection. The token is checked against `/info`, stored
//! encrypted, and a background job mirrors `/products/export` into the
//! inventory: new products become copies (details from the blueprint, codes
//! from the dictionary), changed ones are updated in place, sold-out ones are
//! removed. Locations are never touched here — they come from the scanner or
//! from a stock CSV (`/v1/inventory/locations/csv`).

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::types::Json as Jsonb;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Session;
use crate::catalog_lookup::{self, CardInfo};
use crate::error::ApiError;
use crate::secrets;
use crate::stock_csv::{condition_from_ct, language_code};
use crate::AppState;

/// A sync that has been "running" longer than this is assumed dead (restart).
const STALE_RUN: &str = "15 minutes";
const WRITE_CHUNK: usize = 5000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/integrations/cardtrader",
            get(get_status).put(put_connection).delete(delete_connection),
        )
        .route("/v1/integrations/cardtrader/sync", post(post_sync))
}

// ---------------------------------------------------------------- API client

#[derive(Debug, Deserialize)]
pub struct Info {
    pub id: i64,
    pub name: String,
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct Product {
    pub id: i64,
    pub blueprint_id: i64,
    #[serde(default)]
    pub game_id: Option<i64>,
    #[serde(default)]
    pub name_en: Option<String>,
    #[serde(default)]
    pub quantity: i64,
    #[serde(default)]
    pub price_cents: Option<i64>,
    #[serde(default)]
    pub price_currency: Option<String>,
    #[serde(default)]
    pub properties_hash: Option<Map<String, Value>>,
    #[serde(default)]
    pub expansion: Option<Value>,
}

#[derive(Debug)]
pub enum CtError {
    Unauthorized,
    Upstream(String),
}

impl std::fmt::Display for CtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CtError::Unauthorized => write!(f, "CardTrader refused the token. Paste a valid API token from your CardTrader settings."),
            CtError::Upstream(m) => write!(f, "CardTrader is not answering right now ({m}). Try again later."),
        }
    }
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("CardRails/1.0")
            .gzip(true)
            .build()
            .expect("http client")
    })
}

async fn ct_get<T: serde::de::DeserializeOwned>(base: &str, token: &str, path: &str) -> Result<T, CtError> {
    let response = http()
        .get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| CtError::Upstream(if e.is_timeout() { "timeout".into() } else { "network".into() }))?;
    match response.status().as_u16() {
        200 => response.json::<T>().await.map_err(|_| CtError::Upstream("unexpected response".into())),
        401 | 403 => Err(CtError::Unauthorized),
        code => Err(CtError::Upstream(format!("HTTP {code}"))),
    }
}

pub async fn fetch_info(base: &str, token: &str) -> Result<Info, CtError> {
    ct_get(base, token, "/info").await
}

pub async fn fetch_products(base: &str, token: &str) -> Result<Vec<Product>, CtError> {
    ct_get(base, token, "/products/export").await
}

/// Expansion names, only fetched when a product is missing from our catalogs.
async fn fetch_expansions(base: &str, token: &str) -> HashMap<i64, String> {
    #[derive(Deserialize)]
    struct Expansion {
        id: i64,
        name: String,
    }
    ct_get::<Vec<Expansion>>(base, token, "/expansions")
        .await
        .map(|list| list.into_iter().map(|e| (e.id, e.name)).collect())
        .unwrap_or_default()
}

pub fn is_one_day_ready(app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    ["1 day ready", "1-day ready", "1day ready", "one day ready", "one-day ready", "1-day-ready"]
        .iter()
        .any(|p| lower.contains(p))
}

// ---------------------------------------------------------------- mapping

/// CardTrader game ids → our game keys.
pub fn game_for(ct_game: i64) -> Option<&'static str> {
    Some(match ct_game {
        1 => "magic",
        4 => "yugioh",
        5 => "pokemon",
        6 => "flesh_and_blood",
        8 => "digimon",
        9 => "dragon_ball_super",
        10 => "vanguard",
        15 => "one_piece",
        18 => "lorcana",
        20 => "star_wars",
        21 => "union_arena",
        22 => "riftbound",
        23 => "gundam",
        24 => "sorcery",
        26 => "palworld",
        27 => "cyberpunk",
        _ => return None,
    })
}

/// One product as an inventory copy (catalog details filled in later).
#[derive(Debug, Clone, PartialEq)]
pub struct Mapped {
    pub ct_product_id: i64,
    pub blueprint_id: i64,
    pub game: &'static str,
    pub language: &'static str,
    pub condition: &'static str,
    pub printing: &'static str,
    pub first_edition: bool,
    pub signed: bool,
    pub altered: bool,
    pub quantity: i32,
    pub price_cents: i64,
    pub currency: String,
    pub name: String,
    pub number: String,
    pub expansion_id: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub enum Skip {
    Game,
    Language,
    Quantity,
}

fn flag(props: &Map<String, Value>, key: &str) -> bool {
    matches!(props.get(key), Some(Value::Bool(true))) || props.get(key).and_then(Value::as_str) == Some("true")
}

/// `pokemon_reverse`, `mtg_foil`, `onepiece_language`… are game-prefixed.
fn suffixed<'a>(props: &'a Map<String, Value>, suffix: &str) -> Option<&'a Value> {
    props.iter().find(|(k, _)| k.ends_with(suffix)).map(|(_, v)| v)
}

pub fn map_product(p: &Product) -> Result<Mapped, Skip> {
    let game = p.game_id.and_then(game_for).ok_or(Skip::Game)?;
    if p.quantity < 1 {
        return Err(Skip::Quantity);
    }
    let empty = Map::new();
    let props = p.properties_hash.as_ref().unwrap_or(&empty);
    let language = match suffixed(props, "_language").and_then(Value::as_str) {
        Some(raw) => language_code(raw).ok_or(Skip::Language)?,
        None => "EN",
    };
    let condition_raw = props.get("condition").and_then(Value::as_str);
    let reverse = suffixed(props, "_reverse").is_some_and(|v| v.as_bool() == Some(true));
    let foil = suffixed(props, "_foil").is_some_and(|v| v.as_bool() == Some(true));
    let printing = match (condition_raw, reverse, foil) {
        // Sealed products (boosters, boxes) carry no condition.
        (None, _, _) => "Sealed",
        (_, true, _) => "Reverse Holo",
        (_, _, true) => "Holo",
        _ => "Standard",
    };
    Ok(Mapped {
        ct_product_id: p.id,
        blueprint_id: p.blueprint_id,
        game,
        language,
        condition: condition_raw.map_or("NM", condition_from_ct),
        printing,
        first_edition: flag(props, "first_edition"),
        signed: flag(props, "signed"),
        altered: flag(props, "altered"),
        quantity: p.quantity.min(10_000) as i32,
        price_cents: p.price_cents.unwrap_or(0).clamp(0, 100_000_000),
        currency: p.price_currency.clone().filter(|c| c.len() == 3).unwrap_or_else(|| "EUR".into()),
        name: p.name_en.clone().unwrap_or_default(),
        number: props.get("collector_number").and_then(Value::as_str).unwrap_or("").to_string(),
        expansion_id: p.expansion.as_ref().and_then(|e| e.get("id")).and_then(Value::as_i64),
    })
}

// ---------------------------------------------------------------- endpoints

#[derive(Deserialize)]
struct ConnectRequest {
    token: String,
}

fn secret_key(state: &AppState) -> Result<[u8; 32], ApiError> {
    state
        .config
        .secret_key
        .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Marketplace connections are not configured on this server."))
}

async fn put_connection(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<ConnectRequest>,
) -> Result<Response, ApiError> {
    let key = secret_key(&state)?;
    let token = body.token.trim();
    if token.len() < 20 || token.len() > 4096 || token.chars().any(char::is_whitespace) {
        return Err(ApiError::bad_request("Paste the CardTrader API token."));
    }
    let info = fetch_info(&state.config.cardtrader_url, token).await.map_err(|e| match e {
        CtError::Unauthorized => ApiError::bad_request(e.to_string()),
        CtError::Upstream(_) => ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()),
    })?;
    let sealed = secrets::encrypt(&key, token)?;
    sqlx::query(
        "INSERT INTO cardtrader_connections (account_id, token_ciphertext, app_id, app_name, ct_user_id) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (account_id) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext, \
           app_id = EXCLUDED.app_id, app_name = EXCLUDED.app_name, ct_user_id = EXCLUDED.ct_user_id, \
           connected_at = now(), \
           sync_status = CASE WHEN cardtrader_connections.sync_status = 'running' THEN 'running' ELSE 'queued' END, \
           sync_error = NULL",
    )
    .bind(session.account_id)
    .bind(sealed)
    .bind(info.id)
    .bind(&info.name)
    .bind(info.user_id)
    .execute(&state.pool)
    .await?;
    spawn_sync(state.clone(), session.account_id);
    let status = status_json(&state.pool, session.account_id).await?;
    Ok((StatusCode::OK, Json(status)).into_response())
}

async fn get_status(State(state): State<AppState>, session: Session) -> Result<Response, ApiError> {
    Ok((StatusCode::OK, Json(status_json(&state.pool, session.account_id).await?)).into_response())
}

async fn post_sync(State(state): State<AppState>, session: Session) -> Result<Response, ApiError> {
    let updated = sqlx::query(
        "UPDATE cardtrader_connections SET sync_status = 'queued' \
         WHERE account_id = $1 AND sync_status <> 'running'",
    )
    .bind(session.account_id)
    .execute(&state.pool)
    .await?;
    let exists: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM cardtrader_connections WHERE account_id = $1")
        .bind(session.account_id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found("Connect CardTrader first."));
    }
    if updated.rows_affected() > 0 {
        spawn_sync(state.clone(), session.account_id);
    }
    Ok((StatusCode::ACCEPTED, Json(status_json(&state.pool, session.account_id).await?)).into_response())
}

/// Forgets the token. Imported copies stay, detached from CardTrader.
async fn delete_connection(State(state): State<AppState>, session: Session) -> Result<Response, ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM cardtrader_connections WHERE account_id = $1")
        .bind(session.account_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE inventory_items SET ct_product_id = NULL WHERE account_id = $1 AND ct_product_id IS NOT NULL")
        .bind(session.account_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(json!({ "connected": false }))).into_response())
}

#[derive(sqlx::FromRow)]
struct StatusRow {
    app_id: i64,
    app_name: String,
    ct_user_id: i64,
    sync_status: String,
    sync_error: Option<String>,
    sync_stats: Value,
    connected_at: String,
    started: Option<String>,
    finished: Option<String>,
}

async fn status_json(pool: &PgPool, account_id: Uuid) -> Result<Value, ApiError> {
    let row: Option<StatusRow> = sqlx::query_as(
        "SELECT app_id, app_name, ct_user_id, sync_status, sync_error, sync_stats, \
           to_char(connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS connected_at, \
           to_char(sync_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS started, \
           to_char(sync_finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS finished \
         FROM cardtrader_connections WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(json!({ "connected": false }));
    };
    let (copies,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(quantity), 0)::bigint FROM inventory_items WHERE account_id = $1 AND ct_product_id IS NOT NULL",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(json!({
        "connected": true,
        "app": { "id": row.app_id, "name": row.app_name, "userId": row.ct_user_id, "oneDayReady": is_one_day_ready(&row.app_name) },
        "connectedAt": row.connected_at,
        "sync": { "status": row.sync_status, "error": row.sync_error, "startedAt": row.started, "finishedAt": row.finished, "stats": row.sync_stats },
        "copies": copies,
    }))
}

// ---------------------------------------------------------------- sync job

pub fn spawn_sync(state: AppState, account_id: Uuid) {
    tokio::spawn(async move {
        if let Err(err) = run_sync(&state, account_id).await {
            tracing::error!(error = %err, %account_id, "cardtrader sync failed to record its result");
        }
    });
}

/// Every few minutes, sync the connections whose last run is old enough.
pub fn spawn_scheduler(state: AppState, every: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let due: Result<Vec<(Uuid,)>, _> = sqlx::query_as(
                "SELECT account_id FROM cardtrader_connections \
                 WHERE sync_status <> 'running' AND (sync_finished_at IS NULL OR sync_finished_at < now() - $1::interval)",
            )
            .bind(format!("{} seconds", every.as_secs()))
            .fetch_all(&state.pool)
            .await;
            for (account_id,) in due.unwrap_or_default() {
                if let Err(err) = run_sync(&state, account_id).await {
                    tracing::error!(error = %err, %account_id, "scheduled cardtrader sync failed");
                }
            }
        }
    });
}

/// Claims the connection, imports, and records the outcome on the row.
pub async fn run_sync(state: &AppState, account_id: Uuid) -> anyhow::Result<()> {
    let claimed: Option<(Vec<u8>,)> = sqlx::query_as(&format!(
        "UPDATE cardtrader_connections SET sync_status = 'running', sync_started_at = now(), sync_error = NULL \
         WHERE account_id = $1 AND (sync_status <> 'running' OR sync_started_at < now() - interval '{STALE_RUN}') \
         RETURNING token_ciphertext"
    ))
    .bind(account_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((sealed,)) = claimed else { return Ok(()) };

    let outcome = match state.config.secret_key {
        Some(key) => match secrets::decrypt(&key, &sealed) {
            Ok(token) => import(state, account_id, &token).await,
            Err(_) => Err(SyncError::User("The stored token can't be read anymore. Connect CardTrader again.".into())),
        },
        None => Err(SyncError::User("Marketplace connections are not configured on this server.".into())),
    };
    match outcome {
        Ok(stats) => {
            tracing::info!(%account_id, stats = %stats, "cardtrader sync done");
            sqlx::query(
                "UPDATE cardtrader_connections SET sync_status = 'done', sync_finished_at = now(), sync_stats = $2 \
                 WHERE account_id = $1",
            )
            .bind(account_id)
            .bind(Jsonb(&stats))
            .execute(&state.pool)
            .await?;
        }
        Err(err) => {
            let message = match err {
                SyncError::User(m) => m,
                SyncError::Internal(e) => {
                    tracing::error!(error = %e, %account_id, "cardtrader sync error");
                    "The import stopped on our side. It will be retried automatically.".to_string()
                }
            };
            sqlx::query(
                "UPDATE cardtrader_connections SET sync_status = 'failed', sync_finished_at = now(), sync_error = $2 \
                 WHERE account_id = $1",
            )
            .bind(account_id)
            .bind(message)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(())
}

enum SyncError {
    User(String),
    Internal(anyhow::Error),
}

impl From<sqlx::Error> for SyncError {
    fn from(e: sqlx::Error) -> Self {
        SyncError::Internal(e.into())
    }
}

impl From<anyhow::Error> for SyncError {
    fn from(e: anyhow::Error) -> Self {
        SyncError::Internal(e)
    }
}

#[derive(sqlx::FromRow)]
struct Existing {
    seq: i64,
    id: String,
    ct_product_id: i64,
    name: String,
    public_id: String,
    cardtrader_blueprint_id: String,
    language: String,
    condition: String,
    printing: String,
    first_edition: bool,
    signed: bool,
    altered: bool,
    quantity: i32,
    cents: i64,
    currency: String,
}

/// Column arrays for one `INSERT … SELECT FROM UNNEST(…)`.
#[derive(Default)]
struct NewRows {
    id: Vec<String>,
    game: Vec<String>,
    name: Vec<String>,
    set_name: Vec<String>,
    number: Vec<String>,
    public_id: Vec<String>,
    blueprint: Vec<String>,
    art: Vec<String>,
    language: Vec<String>,
    condition: Vec<String>,
    printing: Vec<String>,
    first_edition: Vec<bool>,
    signed: Vec<bool>,
    altered: Vec<bool>,
    quantity: Vec<i32>,
    price: Vec<String>,
    currency: Vec<String>,
    product: Vec<i64>,
}

fn price_text(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

async fn import(state: &AppState, account_id: Uuid, token: &str) -> Result<Value, SyncError> {
    let started = Instant::now();
    let base = &state.config.cardtrader_url;
    let products = fetch_products(base, token).await.map_err(|e| SyncError::User(e.to_string()))?;
    let export_ms = started.elapsed().as_millis();

    let mut skipped = json!({ "game": 0, "language": 0, "quantity": 0 });
    let mut mapped: Vec<Mapped> = Vec::with_capacity(products.len());
    let mut seen = HashSet::with_capacity(products.len());
    for p in &products {
        match map_product(p) {
            Ok(m) if seen.insert(m.ct_product_id) => mapped.push(m),
            Ok(_) => {}
            Err(reason) => {
                let key = match reason {
                    Skip::Game => "game",
                    Skip::Language => "language",
                    Skip::Quantity => "quantity",
                };
                skipped[key] = json!(skipped[key].as_i64().unwrap_or(0) + 1);
            }
        }
    }
    drop(products);

    // Card details from the catalogs: public id = 2 × blueprint.
    let mut games: Vec<&'static str> = mapped.iter().map(|m| m.game).collect();
    games.sort_unstable();
    games.dedup();
    let tables = match state.config.catalog_dir.clone() {
        Some(dir) => tokio::task::spawn_blocking(move || {
            games
                .into_iter()
                .map(|g| catalog_lookup::tables_for_game(&dir, g).map(|t| (g, t)))
                .collect::<anyhow::Result<HashMap<_, _>>>()
        })
        .await
        .map_err(anyhow::Error::from)??,
        None => HashMap::new(),
    };
    let details: Vec<Option<CardInfo>> = mapped
        .iter()
        .map(|m| {
            let public_id = (m.blueprint_id * 2).to_string();
            tables.get(m.game).and_then(|list| list.iter().find_map(|t| t.get(&public_id).cloned()))
        })
        .collect();
    let not_in_catalog = details.iter().filter(|d| d.is_none()).count();
    let expansions = if not_in_catalog > 0 { fetch_expansions(base, token).await } else { HashMap::new() };
    let map_ms = started.elapsed().as_millis() - export_ms;

    let existing: Vec<Existing> = sqlx::query_as(
        "SELECT seq, id, ct_product_id, name, public_id, cardtrader_blueprint_id, language, condition, printing, \
           first_edition, signed, altered, quantity, (price * 100)::bigint AS cents, currency \
         FROM inventory_items WHERE account_id = $1 AND ct_product_id IS NOT NULL",
    )
    .bind(account_id)
    .fetch_all(&state.pool)
    .await?;
    let by_product: HashMap<i64, &Existing> = existing.iter().map(|e| (e.ct_product_id, e)).collect();

    let mut new_rows = NewRows::default();
    let (mut up_seq, mut up_qty, mut up_price, mut up_cond, mut up_lang, mut up_print) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut up_fe, mut up_sg, mut up_al, mut up_cur) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut ev_item, mut ev_name, mut ev_delta, mut ev_cause) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut unchanged = 0usize;
    let mut copies = 0i64;
    for (m, info) in mapped.iter().zip(&details) {
        copies += i64::from(m.quantity);
        let (name, set_name, number, art, public_id, blueprint) = match info {
            Some(i) => (i.name.clone(), i.set.clone(), i.number.clone(), i.image.clone(), (m.blueprint_id * 2).to_string(), String::new()),
            None => (
                m.name.clone(),
                m.expansion_id.and_then(|id| expansions.get(&id).cloned()).unwrap_or_default(),
                m.number.clone(),
                String::new(),
                String::new(),
                m.blueprint_id.to_string(),
            ),
        };
        let name = if name.trim().is_empty() { format!("CardTrader {}", m.blueprint_id) } else { name };
        match by_product.get(&m.ct_product_id) {
            Some(e) => {
                let same = e.quantity == m.quantity
                    && e.cents == m.price_cents
                    && e.condition == m.condition
                    && e.language == m.language
                    && e.printing == m.printing
                    && e.first_edition == m.first_edition
                    && e.signed == m.signed
                    && e.altered == m.altered
                    && e.currency == m.currency
                    && e.public_id == public_id
                    && e.cardtrader_blueprint_id == blueprint;
                if same {
                    unchanged += 1;
                    continue;
                }
                if e.quantity != m.quantity {
                    ev_item.push(e.id.clone());
                    ev_name.push(crate::domain::truncate(&e.name, 160));
                    ev_delta.push(m.quantity - e.quantity);
                    ev_cause.push("cardtrader_sync".to_string());
                }
                up_seq.push(e.seq);
                up_qty.push(m.quantity);
                up_price.push(price_text(m.price_cents));
                up_cond.push(m.condition.to_string());
                up_lang.push(m.language.to_string());
                up_print.push(m.printing.to_string());
                up_fe.push(m.first_edition);
                up_sg.push(m.signed);
                up_al.push(m.altered);
                up_cur.push(m.currency.clone());
            }
            None => {
                let id = format!("cr_{}", Uuid::new_v4());
                ev_item.push(id.clone());
                ev_name.push(crate::domain::truncate(&name, 160));
                ev_delta.push(m.quantity);
                ev_cause.push("cardtrader_import".to_string());
                let r = &mut new_rows;
                r.id.push(id);
                r.game.push(m.game.to_string());
                r.name.push(crate::domain::truncate(&name, 160));
                r.set_name.push(crate::domain::truncate(&set_name, 160));
                r.number.push(crate::domain::truncate(&number, 160));
                r.public_id.push(public_id);
                r.blueprint.push(blueprint);
                r.art.push(crate::domain::truncate(&art, 500));
                r.language.push(m.language.to_string());
                r.condition.push(m.condition.to_string());
                r.printing.push(m.printing.to_string());
                r.first_edition.push(m.first_edition);
                r.signed.push(m.signed);
                r.altered.push(m.altered);
                r.quantity.push(m.quantity);
                r.price.push(price_text(m.price_cents));
                r.currency.push(m.currency.clone());
                r.product.push(m.ct_product_id);
            }
        }
    }
    let gone: Vec<&Existing> = existing.iter().filter(|e| !seen.contains(&e.ct_product_id)).collect();
    for e in &gone {
        ev_item.push(e.id.clone());
        ev_name.push(crate::domain::truncate(&e.name, 160));
        ev_delta.push(-e.quantity);
        ev_cause.push("cardtrader_removed".to_string());
    }
    let gone_seq: Vec<i64> = gone.iter().map(|e| e.seq).collect();
    let (created, updated, removed) = (new_rows.id.len(), up_seq.len(), gone_seq.len());

    let write_started = Instant::now();
    if created + updated + removed > 0 {
        let mut tx = state.pool.begin().await?;
        sqlx::query("INSERT INTO workspaces (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        for start in (0..created).step_by(WRITE_CHUNK) {
            let end = (start + WRITE_CHUNK).min(created);
            let r = &new_rows;
            sqlx::query(
                "INSERT INTO inventory_items (id, account_id, game, name, set_name, number, public_id, \
                   cardtrader_blueprint_id, art, language, condition, printing, first_edition, signed, altered, \
                   purpose, quantity, price, currency, source, location, listings, ct_product_id) \
                 SELECT u.id, $1, u.game, u.name, u.set_name, u.number, u.public_id, u.blueprint, u.art, u.language, \
                   u.condition, u.printing, u.fe, u.sg, u.al, 'sale', u.qty, u.price::numeric, u.cur, 'cardtrader', \
                   NULL, '[]'::jsonb, u.product \
                 FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], \
                   $9::text[], $10::text[], $11::text[], $12::text[], $13::bool[], $14::bool[], $15::bool[], \
                   $16::int4[], $17::text[], $18::text[], $19::int8[]) \
                   AS u(id, game, name, set_name, number, public_id, blueprint, art, language, condition, printing, \
                        fe, sg, al, qty, price, cur, product)",
            )
            .bind(account_id)
            .bind(&r.id[start..end])
            .bind(&r.game[start..end])
            .bind(&r.name[start..end])
            .bind(&r.set_name[start..end])
            .bind(&r.number[start..end])
            .bind(&r.public_id[start..end])
            .bind(&r.blueprint[start..end])
            .bind(&r.art[start..end])
            .bind(&r.language[start..end])
            .bind(&r.condition[start..end])
            .bind(&r.printing[start..end])
            .bind(&r.first_edition[start..end])
            .bind(&r.signed[start..end])
            .bind(&r.altered[start..end])
            .bind(&r.quantity[start..end])
            .bind(&r.price[start..end])
            .bind(&r.currency[start..end])
            .bind(&r.product[start..end])
            .execute(&mut *tx)
            .await?;
        }
        if updated > 0 {
            sqlx::query(
                "UPDATE inventory_items i SET quantity = u.qty, price = u.price::numeric, condition = u.cond, \
                   language = u.lang, printing = u.print, first_edition = u.fe, signed = u.sg, altered = u.al, \
                   currency = u.cur, version = i.version + 1, updated_at = now() \
                 FROM UNNEST($2::int8[], $3::int4[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bool[], \
                   $9::bool[], $10::bool[], $11::text[]) AS u(seq, qty, price, cond, lang, print, fe, sg, al, cur) \
                 WHERE i.account_id = $1 AND i.seq = u.seq",
            )
            .bind(account_id)
            .bind(&up_seq)
            .bind(&up_qty)
            .bind(&up_price)
            .bind(&up_cond)
            .bind(&up_lang)
            .bind(&up_print)
            .bind(&up_fe)
            .bind(&up_sg)
            .bind(&up_al)
            .bind(&up_cur)
            .execute(&mut *tx)
            .await?;
        }
        if removed > 0 {
            sqlx::query("DELETE FROM inventory_items WHERE account_id = $1 AND seq = ANY($2)")
                .bind(account_id)
                .bind(&gone_seq)
                .execute(&mut *tx)
                .await?;
        }
        let event_ids: Vec<String> = ev_item.iter().map(|_| format!("event_{}", Uuid::new_v4().simple())).collect();
        sqlx::query(
            "INSERT INTO inventory_events (id, account_id, cause, item_id, name, delta) \
             SELECT u.id, $1, u.cause, u.item, u.name, u.delta \
             FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int4[]) AS u(id, cause, item, name, delta)",
        )
        .bind(account_id)
        .bind(&event_ids)
        .bind(&ev_cause)
        .bind(&ev_item)
        .bind(&ev_name)
        .bind(&ev_delta)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE workspaces SET revision = revision + 1, updated_at = now() WHERE account_id = $1")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    let write_ms = write_started.elapsed().as_millis();

    Ok(json!({
        "products": mapped.len(),
        "copies": copies,
        "created": created,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
        "notInCatalog": not_in_catalog,
        "skipped": skipped,
        "timings": { "exportMs": export_ms, "mapMs": map_ms, "writeMs": write_ms, "totalMs": started.elapsed().as_millis() },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product(props: Value, game: i64) -> Product {
        serde_json::from_value(json!({
            "id": 10, "blueprint_id": 219698, "game_id": game, "name_en": "Oddish", "quantity": 2,
            "price_cents": 150, "price_currency": "EUR", "properties_hash": props, "expansion": { "id": 1922 }
        }))
        .unwrap()
    }

    #[test]
    fn maps_cardtrader_properties_to_codes() {
        let m = map_product(&product(
            json!({ "condition": "Slightly Played", "pokemon_language": "it", "pokemon_reverse": true,
                    "first_edition": true, "signed": false, "altered": false, "collector_number": "001/098" }),
            5,
        ))
        .unwrap();
        assert_eq!((m.game, m.language, m.condition, m.printing), ("pokemon", "IT", "SP", "Reverse Holo"));
        assert!(m.first_edition && !m.signed);
        assert_eq!((m.quantity, m.price_cents, m.number.as_str(), m.expansion_id), (2, 150, "001/098", Some(1922)));

        let m = map_product(&product(json!({ "condition": "Mint", "mtg_language": "jp", "mtg_foil": true }), 1)).unwrap();
        assert_eq!((m.game, m.language, m.condition, m.printing), ("magic", "JP", "M", "Holo"));
        let m = map_product(&product(json!({ "condition": "Played", "onepiece_language": "kr" }), 15)).unwrap();
        assert_eq!((m.game, m.language, m.condition), ("one_piece", "KO", "PL"));
        let m = map_product(&product(json!({ "pokemon_language": "it" }), 5)).unwrap();
        assert_eq!((m.condition, m.printing), ("NM", "Sealed"));

        assert_eq!(map_product(&product(json!({}), 99)), Err(Skip::Game));
        assert_eq!(map_product(&product(json!({ "pokemon_language": "ru" }), 5)), Err(Skip::Language));
    }

    #[test]
    fn one_day_ready_apps_are_recognised() {
        assert!(is_one_day_ready("Seller 1-Day Ready App 2025"));
        assert!(is_one_day_ready("One Day Ready"));
        assert!(!is_one_day_ready("Seller App 2025"));
    }
}
