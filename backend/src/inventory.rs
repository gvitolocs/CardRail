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
use crate::domain;
use crate::error::ApiError;
use crate::AppState;

const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/inventory", get(get_inventory))
        .route("/v1/inventory/settings", put(put_settings))
        .route("/v1/inventory/scans", post(post_scans))
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

async fn fetch_items(pool: &PgPool, account_id: Uuid) -> Result<Vec<ItemRow>, ApiError> {
    let sql = format!("{ITEM_SELECT} WHERE i.account_id = $1 ORDER BY i.created_at DESC, i.id DESC");
    let rows = sqlx::query_as::<_, ItemRow>(&sql)
        .bind(account_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
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

    let rows = fetch_items(&state.pool, session.account_id).await?;
    let items: Vec<Value> = rows.iter().map(item_json).collect();

    Ok((
        StatusCode::OK,
        Json(json!({
            "items": items,
            "scanSettings": merge_settings(&stored),
            "revision": revision,
        })),
    )
        .into_response())
}

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
    ensure_workspace_tx(&mut tx, session.account_id).await?;
    let (settings, _): (Value, i64) = sqlx::query_as(
        "SELECT scan_settings, revision FROM workspaces WHERE account_id = $1 FOR UPDATE",
    )
    .bind(session.account_id)
    .fetch_one(&mut *tx)
    .await?;
    let settings = merge_settings(&settings);

    if !settings
        .get("locationConfigured")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(location_required());
    }

    let storage_label = settings
        .get("storageLabel")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let stack_size = settings
        .get("stackSize")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let stack = settings.get("stack").and_then(Value::as_i64).unwrap_or(1);
    let start_position = settings
        .get("startPosition")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    if storage_label.is_empty() || stack_size < 1 {
        return Err(location_required());
    }

    // Only the target box matters: ask Postgres for its last occupied position
    // (indexed on account + box) instead of loading every item of the account.
    let occupied_end: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(GREATEST( \
             CASE WHEN jsonb_typeof(location->'end') = 'number' THEN (location->>'end')::bigint ELSE 0 END, \
             CASE WHEN jsonb_typeof(location->'position') = 'number' \
                  THEN (location->>'position')::bigint + GREATEST(quantity, 1) - 1 ELSE 0 END)), 0)::bigint \
         FROM inventory_items WHERE account_id = $1 AND location->>'box' = $2",
    )
    .bind(session.account_id)
    .bind(&storage_label)
    .fetch_one(&mut *tx)
    .await?;
    let mut occupied: HashMap<String, i64> = HashMap::from([(storage_label.clone(), occupied_end)]);

    let mut locations = Vec::with_capacity(valid.len());
    for card in &valid {
        let requested = (stack - 1) * stack_size + start_position;
        let current = *occupied.get(&storage_label).unwrap_or(&0);
        let position = 1.max(requested).max(current + 1);
        let end = position + i64::from(card.quantity).max(1) - 1;
        occupied.insert(storage_label.clone(), end);
        let row = 1 + (position - 1) / stack_size;
        locations.push(json!({
            "box": storage_label,
            "row": row.to_string(),
            "position": position,
            "end": end,
            "stackSize": stack_size,
        }));
    }

    let mut created_ids = Vec::with_capacity(valid.len());
    for (card, location) in valid.iter().zip(locations.iter()) {
        let id = format!("cr_{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO inventory_items \
             (id, account_id, game, name, set_name, number, public_id, cardtrader_blueprint_id, \
              art, language, condition, printing, first_edition, signed, altered, purpose, \
              quantity, price, source, location, photo_id, listings) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, \
                     $16, $17, $18::numeric, 'scan', $19, $20, $21)",
        )
        .bind(&id)
        .bind(session.account_id)
        .bind(&card.game)
        .bind(&card.name)
        .bind(&card.set_name)
        .bind(&card.number)
        .bind(&card.public_id)
        .bind(&card.cardtrader_blueprint_id)
        .bind(&card.art)
        .bind(&card.language)
        .bind(&card.condition)
        .bind(&card.printing)
        .bind(card.first_edition)
        .bind(card.signed)
        .bind(card.altered)
        .bind(&card.purpose)
        .bind(card.quantity)
        .bind(domain::price_string(card.price))
        .bind(Jsonb(location))
        .bind(&card.photo_id)
        .bind(Jsonb(json!([])))
        .execute(&mut *tx)
        .await?;

        let event_id = format!("event_{}", Uuid::new_v4().simple());
        sqlx::query(
            "INSERT INTO inventory_events (id, account_id, cause, item_id, name, delta) \
             VALUES ($1, $2, 'scan_capture', $3, $4, $5)",
        )
        .bind(&event_id)
        .bind(session.account_id)
        .bind(&id)
        .bind(&card.name)
        .bind(card.quantity)
        .execute(&mut *tx)
        .await?;

        created_ids.push(id);
    }

    let mut created = Vec::with_capacity(created_ids.len());
    for id in &created_ids {
        let row = fetch_item_tx(&mut tx, session.account_id, id).await?;
        created.push(item_json(&row));
    }

    let revision = bump_revision_tx(&mut tx, session.account_id).await?;
    let response = json!({ "items": created, "revision": revision });

    sqlx::query("INSERT INTO idempotency_keys (account_id, key, response) VALUES ($1, $2, $3)")
        .bind(session.account_id)
        .bind(key)
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
