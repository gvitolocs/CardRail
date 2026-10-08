use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::types::Json as Jsonb;
use sqlx::{PgPool, Postgres, QueryBuilder, Transaction};
use uuid::Uuid;

use crate::auth::Session;
use crate::catalog_lookup;
use crate::codes;
use crate::domain;
use crate::error::ApiError;
use crate::AppState;

const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/inventory", get(get_inventory))
        .route("/v1/inventory/settings", put(put_settings))
        .route("/v1/inventory/scans", post(post_scans))
        .route("/v1/inventory/compact", get(get_inventory_compact))
        .route("/v1/inventory/import", post(post_import))
        .route(
            "/v1/inventory/items/{id}",
            patch(patch_item).delete(delete_item),
        )
        .route("/v1/photos", post(upload_photo))
        .route("/v1/photos/{id}", get(get_photo))
}

const ITEM_SELECT: &str = "SELECT i.id, i.game, i.name, i.set_name, i.number, i.public_id, \
    i.cardtrader_blueprint_id, i.art, i.language, i.condition, i.printing, i.first_edition, \
    i.signed, i.altered, i.purpose, i.quantity, i.price::float8 AS price, i.currency, i.source, \
    i.location, i.photo_id, i.listings, i.version, i.created_at, i.updated_at, \
    p.sha256 AS photo_sha256, p.bytes AS photo_bytes, p.created_at AS photo_created_at \
    FROM inventory_items i LEFT JOIN photos p \
    ON p.account_id = i.account_id AND p.id = i.photo_id";

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: String,
    game: String,
    name: String,
    set_name: String,
    number: String,
    public_id: String,
    cardtrader_blueprint_id: String,
    art: String,
    language: String,
    condition: String,
    printing: String,
    first_edition: bool,
    signed: bool,
    altered: bool,
    purpose: String,
    quantity: i32,
    price: f64,
    currency: String,
    source: String,
    location: Option<Value>,
    photo_id: Option<String>,
    listings: Value,
    version: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    photo_sha256: Option<String>,
    photo_bytes: Option<i32>,
    photo_created_at: Option<DateTime<Utc>>,
}

fn item_json(row: &ItemRow) -> Value {
    let scan_photo = match (
        &row.photo_id,
        &row.photo_sha256,
        row.photo_bytes,
        row.photo_created_at,
    ) {
        (Some(id), Some(sha256), Some(bytes), Some(captured_at)) => json!({
            "id": id,
            "sha256": sha256,
            "bytes": bytes,
            "capturedAt": captured_at,
            "role": "scan",
            "url": format!("/v1/photos/{id}"),
        }),
        _ => Value::Null,
    };

    json!({
        "id": row.id,
        "identity": {
            "game": row.game,
            "name": row.name,
            "setName": row.set_name,
            "number": row.number,
            "publicId": row.public_id,
            "cardtraderBlueprintId": row.cardtrader_blueprint_id,
        },
        "art": row.art,
        "language": row.language,
        "condition": row.condition,
        "printing": row.printing,
        "firstEdition": row.first_edition,
        "signed": row.signed,
        "altered": row.altered,
        "purpose": row.purpose,
        "quantity": row.quantity,
        "price": row.price,
        "currency": row.currency,
        "source": row.source,
        "location": row.location,
        "scanPhoto": scan_photo,
        "listings": row.listings,
        "version": row.version,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    })
}

fn merge_settings(stored: &Value) -> Value {
    let mut merged = domain::scan_defaults();
    if let (Some(base), Some(extra)) = (merged.as_object_mut(), stored.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    merged
}

async fn ensure_workspace_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<(Value, i64), ApiError> {
    sqlx::query(
        "INSERT INTO workspaces (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(account_id)
    .execute(&mut **tx)
    .await?;

    let row: (Value, i64) =
        sqlx::query_as("SELECT scan_settings, revision FROM workspaces WHERE account_id = $1")
            .bind(account_id)
            .fetch_one(&mut **tx)
            .await?;
    Ok(row)
}

async fn bump_revision_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<i64, ApiError> {
    let (revision,): (i64,) = sqlx::query_as(
        "UPDATE workspaces SET revision = revision + 1, updated_at = now() \
         WHERE account_id = $1 RETURNING revision",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(revision)
}

async fn fetch_item_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    id: &str,
) -> Result<ItemRow, ApiError> {
    let sql = format!("{ITEM_SELECT} WHERE i.account_id = $1 AND i.id = $2");
    let row = sqlx::query_as::<_, ItemRow>(&sql)
        .bind(account_id)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(row)
}

async fn get_inventory(
    State(state): State<AppState>,
    session: Session,
) -> Result<Response, ApiError> {
    sqlx::query(
        "INSERT INTO workspaces (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(session.account_id)
    .execute(&state.pool)
    .await?;

    let (stored, revision): (Value, i64) =
        sqlx::query_as("SELECT scan_settings, revision FROM workspaces WHERE account_id = $1")
            .bind(session.account_id)
            .fetch_one(&state.pool)
            .await?;

    // Postgres builds the JSON array itself: no per-item object tree in the API,
    // so memory stays close to the size of the response even for 50k cards.
    let items: String = sqlx::query_scalar(INVENTORY_JSON_SQL)
        .bind(session.account_id)
        .fetch_one(&state.pool)
        .await?;
    let settings = serde_json::to_string(&merge_settings(&stored)).map_err(anyhow::Error::from)?;
    Ok(json_response(format!(
        r#"{{"items":{items},"scanSettings":{settings},"revision":{revision}}}"#
    )))
}

/// Sync payload: one array per copy with dictionary codes (`GET /v1/dictionary`).
/// Card details come from the blueprint on the device; the optional last element
/// carries what a blueprint can't give (name/set/number of manual copies, photo…).
async fn get_inventory_compact(
    State(state): State<AppState>,
    session: Session,
) -> Result<Response, ApiError> {
    // The ordered json_agg of a large inventory sorts in memory instead of spilling
    // to temp files with the 4 MB default.
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET LOCAL work_mem = '64MB'").execute(&mut *tx).await?;
    let body: String = sqlx::query_scalar(compact_sql())
        .bind(session.account_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json_response(body))
}

/// Row layout, then an optional extras object. `id` is the copy's short `seq`
/// (PATCH/DELETE accept it in place of the `cr_…` id).
const COMPACT_FIELDS: &str = r#"["id","publicId","game","language","condition","printing","quantity","priceCents","box","row","position","end","version","flags"]"#;

fn compact_sql() -> &'static str {
    static SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SQL.get_or_init(|| {
        let games = codes::sql_array(&codes::GAMES);
        let languages = codes::sql_array(&codes::LANGUAGES);
        let conditions = codes::sql_array(&codes::CONDITIONS);
        let printings = codes::sql_array(&codes::PRINTINGS);
        let base = format!(
            "i.seq, \
             CASE WHEN i.public_id ~ '^[0-9]{{1,15}}$' THEN to_json(i.public_id::bigint) \
                  WHEN i.public_id = '' THEN NULL ELSE to_json(i.public_id) END, \
             array_position({games}, i.game), array_position({languages}, i.language), \
             array_position({conditions}, i.condition), \
             COALESCE(to_json(array_position({printings}, i.printing)), to_json(i.printing)), \
             i.quantity, (i.price * 100)::bigint, x.ix, \
             CASE WHEN (i.location->>'row') ~ '^[0-9]+$' THEN (i.location->>'row')::int END, \
             CASE WHEN jsonb_typeof(i.location->'position') = 'number' THEN (i.location->>'position')::bigint END, \
             CASE WHEN jsonb_typeof(i.location->'end') = 'number' THEN (i.location->>'end')::bigint END, \
             i.version, \
             (CASE WHEN i.first_edition THEN {fe} ELSE 0 END) + (CASE WHEN i.signed THEN {sg} ELSE 0 END) \
             + (CASE WHEN i.altered THEN {al} ELSE 0 END) + (CASE WHEN i.purpose = 'collection' THEN {co} ELSE 0 END) \
             + (CASE WHEN i.source = 'import' THEN {im} ELSE 0 END) \
             + (CASE WHEN i.ct_product_id IS NOT NULL THEN {ct} ELSE 0 END)",
            fe = codes::FLAG_FIRST_EDITION,
            sg = codes::FLAG_SIGNED,
            al = codes::FLAG_ALTERED,
            co = codes::FLAG_COLLECTION,
            im = codes::FLAG_IMPORTED,
            ct = codes::FLAG_CARDTRADER,
        );
        format!(
            "WITH items AS (SELECT * FROM inventory_items WHERE account_id = $1), \
             boxes AS (SELECT box, row_number() OVER (ORDER BY box) - 1 AS ix \
                       FROM (SELECT DISTINCT location->>'box' AS box FROM items \
                             WHERE location->>'box' IS NOT NULL) b), \
             rows AS ( \
               SELECT i.seq, x.ix, \
                 CASE WHEN jsonb_typeof(i.location->'position') = 'number' THEN (i.location->>'position')::bigint END AS pos, \
                 CASE WHEN i.public_id = '' OR i.cardtrader_blueprint_id <> '' OR i.photo_id IS NOT NULL \
                        OR i.source NOT IN ('scan', 'import', 'cardtrader') OR i.currency <> 'EUR' OR i.listings <> '[]'::jsonb \
                   THEN json_build_array({base}, json_strip_nulls(json_build_object( \
                     'n', CASE WHEN i.public_id = '' THEN i.name END, \
                     's', CASE WHEN i.public_id = '' THEN i.set_name END, \
                     'k', CASE WHEN i.public_id = '' THEN i.number END, \
                     'a', CASE WHEN i.public_id = '' AND i.art <> '' THEN i.art END, \
                     'b', NULLIF(i.cardtrader_blueprint_id, ''), \
                     'p', i.photo_id, \
                     'src', CASE WHEN i.source NOT IN ('scan', 'import', 'cardtrader') THEN i.source END, \
                     'c', CASE WHEN i.currency <> 'EUR' THEN i.currency END, \
                     'l', CASE WHEN i.listings <> '[]'::jsonb THEN i.listings END))) \
                   ELSE json_build_array({base}) END AS r \
               FROM items i LEFT JOIN boxes x ON x.box = i.location->>'box') \
             SELECT json_build_object( \
               'v', 1, 'dictionary', {dict}, 'currency', 'EUR', \
               'revision', COALESCE((SELECT revision FROM workspaces WHERE account_id = $1), 0), \
               'boxes', COALESCE((SELECT json_agg(box ORDER BY ix) FROM boxes), '[]'::json), \
               'fields', '{fields}'::json, \
               'rows', COALESCE((SELECT json_agg(r ORDER BY ix NULLS LAST, pos NULLS LAST, seq) FROM rows), '[]'::json) \
             )::text",
            dict = codes::VERSION,
            fields = COMPACT_FIELDS,
        )
    })
}

/// PATCH/DELETE take either the full `cr_…` id or the compact numeric `seq`.
async fn resolve_item_id(pool: &PgPool, account_id: Uuid, raw: String) -> Result<String, ApiError> {
    let Ok(seq) = raw.parse::<i64>() else { return Ok(raw) };
    let id: Option<String> =
        sqlx::query_scalar("SELECT id FROM inventory_items WHERE account_id = $1 AND seq = $2")
            .bind(account_id)
            .bind(seq)
            .fetch_optional(pool)
            .await?;
    id.ok_or_else(|| ApiError::not_found("Card not found."))
}

fn json_response(body: String) -> Response {
    let mut response = (StatusCode::OK, body).into_response();
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

/// One copy as JSON, built by Postgres (`i` = inventory_items, `p` = photos);
/// the same shape as `item_json`.
macro_rules! item_json_sql {
    () => {
        concat!(
            "json_build_object(",
            "'id', i.id, ",
                "'identity', json_build_object('game', i.game, 'name', i.name, 'setName', i.set_name, ",
                "'number', i.number, 'publicId', i.public_id, 'cardtraderBlueprintId', i.cardtrader_blueprint_id), ",
                "'art', i.art, 'language', i.language, 'condition', i.condition, 'printing', i.printing, ",
                "'firstEdition', i.first_edition, 'signed', i.signed, 'altered', i.altered, 'purpose', i.purpose, ",
                "'quantity', i.quantity, 'price', i.price::float8, 'currency', i.currency, 'source', i.source, ",
                "'location', i.location, ",
                "'scanPhoto', CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'sha256', p.sha256, ",
                "'bytes', p.bytes, 'capturedAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), ",
                "'role', 'scan', 'url', '/v1/photos/' || p.id) END, ",
                "'listings', i.listings, 'version', i.version, ",
                "'createdAt', to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), ",
                "'updatedAt', to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
                ")"
        )
    };
}

const INVENTORY_JSON_SQL: &str = concat!(
    "SELECT COALESCE(json_agg(",
    item_json_sql!(),
    " ORDER BY i.created_at DESC, i.id DESC), '[]'::json)::text ",
    "FROM inventory_items i LEFT JOIN photos p ON p.account_id = i.account_id AND p.id = i.photo_id ",
    "WHERE i.account_id = $1"
);


fn apply_settings(
    settings: &mut Value,
    patch: &serde_json::Map<String, Value>,
) -> Result<(), ApiError> {
    let obj = settings
        .as_object_mut()
        .ok_or_else(|| ApiError::bad_request("Invalid settings."))?;

    for (key, value) in patch {
        match key.as_str() {
            "game" => {
                let game = domain::normalize_game(value.as_str().unwrap_or(""))?;
                obj.insert("game".into(), Value::String(game));
            }
            "language" => {
                let language = domain::validate_language(value.as_str().unwrap_or(""))?;
                obj.insert("language".into(), Value::String(language));
            }
            "condition" => {
                let condition = domain::validate_condition(value.as_str().unwrap_or(""))?;
                obj.insert("condition".into(), Value::String(condition));
            }
            "printing" => {
                let printing = domain::validate_printing(value.as_str().unwrap_or(""))?;
                obj.insert("printing".into(), Value::String(printing));
            }
            "storageLabel" => {
                let label = domain::truncate(value.as_str().unwrap_or(""), 64);
                obj.insert("storageLabel".into(), Value::String(label));
            }
            "stackSize" => {
                if value.is_null() {
                    obj.insert("stackSize".into(), Value::Null);
                } else {
                    let size = value
                        .as_i64()
                        .filter(|size| (1..=10_000).contains(size))
                        .ok_or_else(invalid_stack)?;
                    obj.insert("stackSize".into(), json!(size));
                }
            }
            "stack" | "startPosition" => {
                let number = value
                    .as_i64()
                    .filter(|number| (1..=10_000).contains(number))
                    .ok_or_else(invalid_stack)?;
                obj.insert(key.clone(), json!(number));
            }
            "firstEdition" | "signed" | "altered" | "mergeRepeats" | "paused" => {
                let flag = value.as_bool().ok_or_else(invalid_scan_setting)?;
                obj.insert(key.clone(), Value::Bool(flag));
            }
            _ => {}
        }
    }

    let label = obj
        .get("storageLabel")
        .and_then(Value::as_str)
        .unwrap_or("");
    let size = obj.get("stackSize").and_then(Value::as_i64);
    let configured = !label.is_empty() && matches!(size, Some(size) if size > 0);
    obj.insert("locationConfigured".into(), Value::Bool(configured));

    Ok(())
}

fn invalid_stack() -> ApiError {
    ApiError::bad_request("Invalid stack position.")
}

fn invalid_scan_setting() -> ApiError {
    ApiError::bad_request("Invalid scan setting.")
}

async fn put_settings(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let patch = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Invalid settings."))?;

    let mut tx = state.pool.begin().await?;
    let (stored, _) = ensure_workspace_tx(&mut tx, session.account_id).await?;
    let mut settings = merge_settings(&stored);
    apply_settings(&mut settings, patch)?;

    let (revision,): (i64,) = sqlx::query_as(
        "UPDATE workspaces SET scan_settings = $2, revision = revision + 1, updated_at = now() \
         WHERE account_id = $1 RETURNING revision",
    )
    .bind(session.account_id)
    .bind(Jsonb(&settings))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok((
        StatusCode::OK,
        Json(json!({ "scanSettings": settings, "revision": revision })),
    )
        .into_response())
}

async fn upload_photo(
    State(state): State<AppState>,
    session: Session,
    body: Bytes,
) -> Result<Response, ApiError> {
    if body.len() > MAX_PHOTO_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Choose a card photo under 2 MB.",
        ));
    }
    if body.len() < 3 || body[0] != 0xFF || body[1] != 0xD8 || body[2] != 0xFF {
        return Err(ApiError::bad_request("Invalid JPEG photo."));
    }

    let sha256 = hex::encode(Sha256::digest(&body));
    let id = format!("photo_{}", &sha256[..18]);
    let bytes = body.len() as i32;

    sqlx::query(
        "INSERT INTO photos (account_id, id, sha256, bytes, data) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (account_id, id) DO NOTHING",
    )
    .bind(session.account_id)
    .bind(&id)
    .bind(&sha256)
    .bind(bytes)
    .bind(body.as_ref())
    .execute(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "sha256": sha256,
            "bytes": bytes,
            "url": format!("/v1/photos/{id}"),
        })),
    )
        .into_response())
}

async fn get_photo(
    State(state): State<AppState>,
    session: Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let row: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT data FROM photos WHERE account_id = $1 AND id = $2")
            .bind(session.account_id)
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let (data,) = row.ok_or_else(|| ApiError::not_found("Photo not found."))?;

    let mut response = (StatusCode::OK, data).into_response();
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRequest {
    idempotency_key: String,
    #[serde(default)]
    intent: String,
    cards: Vec<ScanCardInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanCardInput {
    identity: IdentityInput,
    #[serde(default)]
    art: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    condition: String,
    #[serde(default)]
    printing: String,
    #[serde(default)]
    first_edition: bool,
    #[serde(default)]
    signed: bool,
    #[serde(default)]
    altered: bool,
    quantity: i64,
    #[serde(default)]
    price: f64,
    #[serde(default)]
    photo_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityInput {
    #[serde(default)]
    game: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    set_name: String,
    #[serde(default)]
    number: String,
    #[serde(default)]
    public_id: String,
    #[serde(default)]
    cardtrader_blueprint_id: String,
}

struct ValidCard {
    game: String,
    name: String,
    set_name: String,
    number: String,
    public_id: String,
    cardtrader_blueprint_id: String,
    art: String,
    language: String,
    condition: String,
    printing: String,
    first_edition: bool,
    signed: bool,
    altered: bool,
    purpose: String,
    quantity: i32,
    price: f64,
    photo_id: Option<String>,
}

fn validate_card(input: ScanCardInput, intent: &str) -> Result<ValidCard, ApiError> {
    let game = domain::normalize_game(&input.identity.game)?;
    let name = domain::validate_identity_text(&input.identity.name)?;
    let set_name = domain::validate_identity_text(&input.identity.set_name)?;
    let number = domain::validate_identity_text(&input.identity.number)?;
    let public_id = domain::truncate(&input.identity.public_id, 160);
    let cardtrader_blueprint_id = domain::truncate(&input.identity.cardtrader_blueprint_id, 160);
    let art = domain::truncate(&input.art, 500);
    let language = domain::validate_language(&input.language)?;
    let condition = domain::validate_condition(&input.condition)?;
    let printing = domain::validate_printing(&input.printing)?;
    let quantity = domain::validate_quantity(input.quantity, false)?;
    let price = domain::validate_price(input.price)?;

    let purpose = if intent == "collection" {
        "collection"
    } else {
        "sale"
    };
    let price = if purpose == "collection" { 0.0 } else { price };

    Ok(ValidCard {
        game,
        name,
        set_name,
        number,
        public_id,
        cardtrader_blueprint_id,
        art,
        language,
        condition,
        printing,
        first_edition: input.first_edition,
        signed: input.signed,
        altered: input.altered,
        purpose: purpose.to_string(),
        quantity,
        price,
        photo_id: input.photo_id,
    })
}

/// Next free positions in the configured box, one range per copy count — the
/// web app's `allocateScanLocations` rule. Only that box's last position is read.
async fn allocate_locations(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    settings: &Value,
    quantities: impl Iterator<Item = i32>,
) -> Result<Vec<Value>, ApiError> {
    let storage_label = settings
        .get("storageLabel")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let stack_size = settings.get("stackSize").and_then(Value::as_i64).unwrap_or(0);
    let stack = settings.get("stack").and_then(Value::as_i64).unwrap_or(1);
    let start_position = settings.get("startPosition").and_then(Value::as_i64).unwrap_or(1);
    if storage_label.is_empty() || stack_size < 1 {
        return Err(location_required());
    }

    let mut current: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(GREATEST( \
             CASE WHEN jsonb_typeof(location->'end') = 'number' THEN (location->>'end')::bigint ELSE 0 END, \
             CASE WHEN jsonb_typeof(location->'position') = 'number' \
                  THEN (location->>'position')::bigint + GREATEST(quantity, 1) - 1 ELSE 0 END)), 0)::bigint \
         FROM inventory_items WHERE account_id = $1 AND location->>'box' = $2",
    )
    .bind(account_id)
    .bind(&storage_label)
    .fetch_one(&mut **tx)
    .await?;

    let requested = (stack - 1) * stack_size + start_position;
    let mut locations = Vec::new();
    for quantity in quantities {
        let position = 1.max(requested).max(current + 1);
        let end = position + i64::from(quantity).max(1) - 1;
        current = end;
        locations.push(json!({
            "box": storage_label,
            "row": (1 + (position - 1) / stack_size).to_string(),
            "position": position,
            "end": end,
            "stackSize": stack_size,
        }));
    }
    Ok(locations)
}

fn conflict_changed() -> ApiError {
    ApiError::conflict("This card changed on another device. Refresh and try again.")
}

fn location_required() -> ApiError {
    ApiError::bad_request("Set a real location and stack capacity before adding cards to inventory.")
}

async fn photo_exists(pool: &PgPool, account_id: Uuid, id: &str) -> Result<bool, ApiError> {
    let row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM photos WHERE account_id = $1 AND id = $2")
            .bind(account_id)
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

async fn post_scans(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<ScanRequest>,
) -> Result<Response, ApiError> {
    let key = body.idempotency_key.trim();
    if key.chars().count() < 8 || key.chars().count() > 80 {
        return Err(ApiError::bad_request("An idempotency key is required."));
    }

    let stored: Option<(Value,)> =
        sqlx::query_as("SELECT response FROM idempotency_keys WHERE account_id = $1 AND key = $2")
            .bind(session.account_id)
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((response,)) = stored {
        return Ok((StatusCode::OK, Json(response)).into_response());
    }

    if body.cards.is_empty() || body.cards.len() > 200 {
        return Err(ApiError::bad_request("Select scanned cards."));
    }

    let mut valid = Vec::with_capacity(body.cards.len());
    for card in body.cards {
        valid.push(validate_card(card, &body.intent)?);
    }

    for card in &valid {
        if let Some(photo_id) = &card.photo_id {
            if !photo_exists(&state.pool, session.account_id, photo_id).await? {
                return Err(ApiError::bad_request("Photo not found."));
            }
        }
    }

    let mut tx = state.pool.begin().await?;
    let settings = lock_workspace_tx(&mut tx, session.account_id).await?;

    if !settings
        .get("locationConfigured")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(location_required());
    }

    let locations =
        allocate_locations(&mut tx, session.account_id, &settings, valid.iter().map(|c| c.quantity))
            .await?;

    // Copies, their events, the revision, the stored idempotent response and the
    // response itself in one round trip, whatever the number of cards.
    let col = |f: fn(&ValidCard) -> String| valid.iter().map(f).collect::<Vec<String>>();
    let ids: Vec<String> = valid.iter().map(|_| format!("cr_{}", Uuid::new_v4())).collect();
    let response: String = sqlx::query_scalar(SCAN_INSERT_SQL)
        .bind(session.account_id)
        .bind(key)
        .bind(&ids)
        .bind(col(|c| c.game.clone()))
        .bind(col(|c| c.name.clone()))
        .bind(col(|c| c.set_name.clone()))
        .bind(col(|c| c.number.clone()))
        .bind(col(|c| c.public_id.clone()))
        .bind(col(|c| c.cardtrader_blueprint_id.clone()))
        .bind(col(|c| c.art.clone()))
        .bind(col(|c| c.language.clone()))
        .bind(col(|c| c.condition.clone()))
        .bind(col(|c| c.printing.clone()))
        .bind(valid.iter().map(|c| c.first_edition).collect::<Vec<_>>())
        .bind(valid.iter().map(|c| c.signed).collect::<Vec<_>>())
        .bind(valid.iter().map(|c| c.altered).collect::<Vec<_>>())
        .bind(col(|c| c.purpose.clone()))
        .bind(valid.iter().map(|c| c.quantity).collect::<Vec<_>>())
        .bind(col(|c| domain::price_string(c.price)))
        .bind(locations.iter().map(Value::to_string).collect::<Vec<_>>())
        .bind(valid.iter().map(|c| c.photo_id.clone()).collect::<Vec<Option<String>>>())
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    let mut created = json_response(response);
    *created.status_mut() = StatusCode::CREATED;
    Ok(created)
}

const SCAN_INSERT_SQL: &str = concat!(
    "WITH ins AS (",
    "INSERT INTO inventory_items (id, account_id, game, name, set_name, number, public_id, ",
    "cardtrader_blueprint_id, art, language, condition, printing, first_edition, signed, altered, ",
    "purpose, quantity, price, source, location, photo_id, listings) ",
    "SELECT u.id, $1, u.game, u.name, u.set_name, u.number, u.public_id, u.blueprint, u.art, u.language, ",
    "u.condition, u.printing, u.fe, u.sg, u.al, u.purpose, u.qty, u.price::numeric, 'scan', u.loc::jsonb, ",
    "u.photo, '[]'::jsonb ",
    "FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], ",
    "$10::text[], $11::text[], $12::text[], $13::text[], $14::bool[], $15::bool[], $16::bool[], ",
    "$17::text[], $18::int4[], $19::text[], $20::text[], $21::text[]) ",
    "AS u(id, game, name, set_name, number, public_id, blueprint, art, language, condition, printing, ",
    "fe, sg, al, purpose, qty, price, loc, photo) ",
    "RETURNING *), ",
    "ev AS (INSERT INTO inventory_events (id, account_id, cause, item_id, name, delta) ",
    "SELECT 'event_' || replace(gen_random_uuid()::text, '-', ''), $1, 'scan_capture', ins.id, ins.name, ins.quantity FROM ins), ",
    "rev AS (UPDATE workspaces SET revision = revision + 1, updated_at = now() WHERE account_id = $1 RETURNING revision), ",
    "resp AS (SELECT json_build_object('items', (SELECT json_agg(",
    item_json_sql!(),
    " ORDER BY array_position($3::text[], i.id)) FROM ins i LEFT JOIN photos p ",
    "ON p.account_id = i.account_id AND p.id = i.photo_id), 'revision', (SELECT revision FROM rev)) AS r), ",
    "idem AS (INSERT INTO idempotency_keys (account_id, key, response) SELECT $1, $2, r::jsonb FROM resp) ",
    "SELECT r::text FROM resp"
);

/// Locks the account's workspace row for the rest of the transaction and returns
/// its scan settings (merged with defaults). Creates the row the first time.
async fn lock_workspace_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<Value, ApiError> {
    let select = "SELECT scan_settings FROM workspaces WHERE account_id = $1 FOR UPDATE";
    let mut row: Option<(Value,)> = sqlx::query_as(select).bind(account_id).fetch_optional(&mut **tx).await?;
    if row.is_none() {
        sqlx::query("INSERT INTO workspaces (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING")
            .bind(account_id)
            .execute(&mut **tx)
            .await?;
        row = sqlx::query_as(select).bind(account_id).fetch_optional(&mut **tx).await?;
    }
    let (settings,) = row.ok_or_else(|| ApiError::internal("Workspace missing."))?;
    Ok(merge_settings(&settings))
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRequest {
    idempotency_key: String,
    #[serde(default)]
    intent: String,
    rows: Vec<Vec<Value>>,
}

const MAX_IMPORT_ROWS: usize = 5000;

struct ImportCard {
    game: &'static str,
    public_id: String,
    language: &'static str,
    condition: &'static str,
    printing: String,
    quantity: i32,
    price: f64,
    flags: i64,
}

fn parse_import_row(row: &[Value], collection: bool) -> Result<ImportCard, ApiError> {
    let bad = || ApiError::bad_request("Each row is [publicId, game, language, condition, printing, quantity, priceCents, flags].");
    let public_id = match row.first() {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return Err(bad()),
    };
    let game = codes::decode(&codes::GAMES, row.get(1).ok_or_else(bad)?).ok_or_else(|| ApiError::bad_request("Choose a game."))?;
    let language = codes::decode(&codes::LANGUAGES, row.get(2).ok_or_else(bad)?)
        .ok_or_else(|| ApiError::bad_request("Choose a card language."))?;
    let condition = codes::decode(&codes::CONDITIONS, row.get(3).ok_or_else(bad)?)
        .ok_or_else(|| ApiError::bad_request("Choose a card condition."))?;
    let printing = match row.get(4) {
        Some(Value::String(text)) => domain::validate_printing(text)?,
        Some(code) => codes::decode(&codes::PRINTINGS, code)
            .ok_or_else(|| ApiError::bad_request("Finish is required."))?
            .to_string(),
        None => return Err(bad()),
    };
    let quantity = domain::validate_quantity(row.get(5).and_then(Value::as_i64).ok_or_else(bad)?, false)?;
    let cents = row.get(6).and_then(Value::as_i64).unwrap_or(0);
    let flags = row.get(7).and_then(Value::as_i64).unwrap_or(0);
    let collection = collection || flags & codes::FLAG_COLLECTION != 0;
    let price = if collection { 0.0 } else { domain::validate_price(cents as f64 / 100.0)? };
    Ok(ImportCard {
        game,
        public_id,
        language,
        condition,
        printing,
        quantity,
        price,
        flags: if collection { flags | codes::FLAG_COLLECTION } else { flags },
    })
}

/// `POST /v1/inventory/import`: compact rows, details resolved from the catalogs,
/// positions allocated like scans, inserted in batches.
async fn post_import(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<ImportRequest>,
) -> Result<Response, ApiError> {
    let key = body.idempotency_key.trim().to_string();
    if key.chars().count() < 8 || key.chars().count() > 80 {
        return Err(ApiError::bad_request("An idempotency key is required."));
    }
    let stored: Option<(Value,)> =
        sqlx::query_as("SELECT response FROM idempotency_keys WHERE account_id = $1 AND key = $2")
            .bind(session.account_id)
            .bind(&key)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((response,)) = stored {
        return Ok((StatusCode::OK, Json(response)).into_response());
    }
    if body.rows.is_empty() || body.rows.len() > MAX_IMPORT_ROWS {
        return Err(ApiError::bad_request("Send between 1 and 5000 rows."));
    }
    let collection = body.intent == "collection";
    let cards = body
        .rows
        .iter()
        .map(|row| parse_import_row(row, collection))
        .collect::<Result<Vec<_>, _>>()?;

    let Some(dir) = state.config.catalog_dir.clone() else {
        return Err(ApiError::bad_request("Catalogs are not available on this server."));
    };
    let games: Vec<&'static str> = {
        let mut g: Vec<&'static str> = cards.iter().map(|c| c.game).collect();
        g.sort_unstable();
        g.dedup();
        g
    };
    let tables = tokio::task::spawn_blocking(move || {
        games
            .into_iter()
            .map(|game| catalog_lookup::tables_for_game(&dir, game).map(|t| (game, t)))
            .collect::<anyhow::Result<HashMap<_, _>>>()
    })
    .await
    .map_err(anyhow::Error::from)??;

    let mut details = Vec::with_capacity(cards.len());
    let mut missing = Vec::new();
    for card in &cards {
        let found = tables
            .get(card.game)
            .and_then(|list| list.iter().find_map(|table| table.get(&card.public_id)));
        match found {
            Some(info) => details.push(info.clone()),
            None => {
                if missing.len() < 5 {
                    missing.push(format!("{}/{}", card.game, card.public_id));
                }
                details.push(catalog_lookup::CardInfo {
                    name: String::new(),
                    set: String::new(),
                    number: String::new(),
                    image: String::new(),
                });
            }
        }
    }
    if !missing.is_empty() {
        return Err(ApiError::bad_request(format!("Unknown blueprints: {}.", missing.join(", "))));
    }

    let mut tx = state.pool.begin().await?;
    ensure_workspace_tx(&mut tx, session.account_id).await?;
    let (settings, _): (Value, i64) = sqlx::query_as(
        "SELECT scan_settings, revision FROM workspaces WHERE account_id = $1 FOR UPDATE",
    )
    .bind(session.account_id)
    .fetch_one(&mut *tx)
    .await?;
    let settings = merge_settings(&settings);
    if !settings.get("locationConfigured").and_then(Value::as_bool).unwrap_or(false) {
        return Err(location_required());
    }
    let locations =
        allocate_locations(&mut tx, session.account_id, &settings, cards.iter().map(|c| c.quantity)).await?;

    let ids: Vec<String> = cards.iter().map(|_| format!("cr_{}", Uuid::new_v4())).collect();
    for chunk in (0..cards.len()).collect::<Vec<_>>().chunks(1000) {
        let mut items = QueryBuilder::<Postgres>::new(
            "INSERT INTO inventory_items (id, account_id, game, name, set_name, number, public_id, art, \
             language, condition, printing, first_edition, signed, altered, purpose, quantity, price, \
             source, location, listings) ",
        );
        items.push_values(chunk, |mut b, &i| {
            let (card, info) = (&cards[i], &details[i]);
            b.push_bind(&ids[i])
                .push_bind(session.account_id)
                .push_bind(card.game)
                .push_bind(domain::truncate(&info.name, 160))
                .push_bind(domain::truncate(&info.set, 160))
                .push_bind(domain::truncate(&info.number, 160))
                .push_bind(&card.public_id)
                .push_bind(domain::truncate(&info.image, 500))
                .push_bind(card.language)
                .push_bind(card.condition)
                .push_bind(&card.printing)
                .push_bind(card.flags & codes::FLAG_FIRST_EDITION != 0)
                .push_bind(card.flags & codes::FLAG_SIGNED != 0)
                .push_bind(card.flags & codes::FLAG_ALTERED != 0)
                .push_bind(if card.flags & codes::FLAG_COLLECTION != 0 { "collection" } else { "sale" })
                .push_bind(card.quantity)
                .push_bind(domain::price_string(card.price))
                .push_unseparated("::numeric")
                .push_bind("import")
                .push_bind(Jsonb(&locations[i]))
                .push_bind(Jsonb(json!([])));
        });
        items.build().execute(&mut *tx).await?;

        let mut events = QueryBuilder::<Postgres>::new(
            "INSERT INTO inventory_events (id, account_id, cause, item_id, name, delta) ",
        );
        events.push_values(chunk, |mut b, &i| {
            b.push_bind(format!("event_{}", Uuid::new_v4().simple()))
                .push_bind(session.account_id)
                .push_bind("import")
                .push_bind(&ids[i])
                .push_bind(domain::truncate(&details[i].name, 160))
                .push_bind(cards[i].quantity);
        });
        events.build().execute(&mut *tx).await?;
    }

    let revision = bump_revision_tx(&mut tx, session.account_id).await?;
    let response = json!({ "imported": cards.len(), "revision": revision });
    sqlx::query("INSERT INTO idempotency_keys (account_id, key, response) VALUES ($1, $2, $3)")
        .bind(session.account_id)
        .bind(&key)
        .bind(Jsonb(&response))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchRequest {
    version: i32,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    condition: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    printing: Option<String>,
    #[serde(default)]
    first_edition: Option<bool>,
    #[serde(default)]
    signed: Option<bool>,
    #[serde(default)]
    altered: Option<bool>,
}

async fn patch_item(
    State(state): State<AppState>,
    session: Session,
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> Result<Response, ApiError> {
    let id = resolve_item_id(&state.pool, session.account_id, id).await?;
    let quantity = match body.quantity {
        Some(value) => Some(domain::validate_quantity(value, true)?),
        None => None,
    };
    let price = match body.price {
        Some(value) => Some(domain::price_string(domain::validate_price(value)?)),
        None => None,
    };
    let condition = match &body.condition {
        Some(value) => Some(domain::validate_condition(value)?),
        None => None,
    };
    let language = match &body.language {
        Some(value) => Some(domain::validate_language(value)?),
        None => None,
    };
    let printing = match &body.printing {
        Some(value) => Some(domain::validate_printing(value)?),
        None => None,
    };

    let mut tx = state.pool.begin().await?;
    ensure_workspace_tx(&mut tx, session.account_id).await?;

    let current: Option<(i32, String, i32)> = sqlx::query_as(
        "SELECT quantity, name, version FROM inventory_items WHERE id = $1 AND account_id = $2",
    )
    .bind(&id)
    .bind(session.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (old_quantity, name, current_version) =
        current.ok_or_else(|| ApiError::not_found("Card not found."))?;

    if current_version != body.version {
        return Err(conflict_changed());
    }

    let mut qb = QueryBuilder::<Postgres>::new(
        "UPDATE inventory_items SET version = version + 1, updated_at = now()",
    );
    if let Some(quantity) = quantity {
        qb.push(", quantity = ").push_bind(quantity);
    }
    if let Some(price) = &price {
        qb.push(", price = ")
            .push_bind(price.as_str())
            .push("::numeric");
    }
    if let Some(condition) = &condition {
        qb.push(", condition = ").push_bind(condition.as_str());
    }
    if let Some(language) = &language {
        qb.push(", language = ").push_bind(language.as_str());
    }
    if let Some(printing) = &printing {
        qb.push(", printing = ").push_bind(printing.as_str());
    }
    if let Some(first_edition) = body.first_edition {
        qb.push(", first_edition = ").push_bind(first_edition);
    }
    if let Some(signed) = body.signed {
        qb.push(", signed = ").push_bind(signed);
    }
    if let Some(altered) = body.altered {
        qb.push(", altered = ").push_bind(altered);
    }
    qb.push(" WHERE id = ")
        .push_bind(id.as_str())
        .push(" AND account_id = ")
        .push_bind(session.account_id)
        .push(" AND version = ")
        .push_bind(body.version);

    let result = qb.build().execute(&mut *tx).await?;
    if result.rows_affected() == 0 {
        return Err(conflict_changed());
    }

    if let Some(quantity) = quantity {
        if quantity != old_quantity {
            let event_id = format!("event_{}", Uuid::new_v4().simple());
            sqlx::query(
                "INSERT INTO inventory_events (id, account_id, cause, item_id, name, delta) \
                 VALUES ($1, $2, 'manual_adjust', $3, $4, $5)",
            )
            .bind(&event_id)
            .bind(session.account_id)
            .bind(&id)
            .bind(&name)
            .bind(quantity - old_quantity)
            .execute(&mut *tx)
            .await?;
        }
    }

    let revision = bump_revision_tx(&mut tx, session.account_id).await?;
    let row = fetch_item_tx(&mut tx, session.account_id, &id).await?;
    let item = item_json(&row);
    tx.commit().await?;

    Ok((
        StatusCode::OK,
        Json(json!({ "item": item, "revision": revision })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct VersionQuery {
    version: i32,
}

async fn delete_item(
    State(state): State<AppState>,
    session: Session,
    Path(id): Path<String>,
    Query(query): Query<VersionQuery>,
) -> Result<Response, ApiError> {
    let id = resolve_item_id(&state.pool, session.account_id, id).await?;
    let mut tx = state.pool.begin().await?;
    ensure_workspace_tx(&mut tx, session.account_id).await?;

    let current: Option<(i32, String, i32)> = sqlx::query_as(
        "SELECT quantity, name, version FROM inventory_items WHERE id = $1 AND account_id = $2",
    )
    .bind(&id)
    .bind(session.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (quantity, name, current_version) =
        current.ok_or_else(|| ApiError::not_found("Card not found."))?;

    if current_version != query.version {
        return Err(conflict_changed());
    }

    let result = sqlx::query(
        "DELETE FROM inventory_items WHERE id = $1 AND account_id = $2 AND version = $3",
    )
    .bind(&id)
    .bind(session.account_id)
    .bind(query.version)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(conflict_changed());
    }

    let event_id = format!("event_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO inventory_events (id, account_id, cause, item_id, name, delta) \
         VALUES ($1, $2, 'removed', $3, $4, $5)",
    )
    .bind(&event_id)
    .bind(session.account_id)
    .bind(&id)
    .bind(&name)
    .bind(-quantity)
    .execute(&mut *tx)
    .await?;

    let revision = bump_revision_tx(&mut tx, session.account_id).await?;
    tx.commit().await?;

    Ok((
        StatusCode::OK,
        Json(json!({ "ok": true, "revision": revision })),
    )
        .into_response())
}
