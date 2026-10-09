pub mod auth;
pub mod cardtrader;
pub mod catalog_lookup;
pub mod codes;
pub mod config;
pub mod domain;
pub mod error;
pub mod inventory;
pub mod secrets;
pub mod stock_csv;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::header::{
    ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN, TRANSFER_ENCODING,
};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::ServeDir;

use crate::config::Config;
use crate::error::ApiError;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
}

pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001_accounts.sql",
        include_str!("../sql/001_accounts.sql"),
    ),
    (
        "002_inventory.sql",
        include_str!("../sql/002_inventory.sql"),
    ),
    (
        "003_android_client.sql",
        include_str!("../sql/003_android_client.sql"),
    ),
    (
        "004_inventory_box_index.sql",
        include_str!("../sql/004_inventory_box_index.sql"),
    ),
    (
        "005_inventory_seq.sql",
        include_str!("../sql/005_inventory_seq.sql"),
    ),
    (
        "006_cardtrader.sql",
        include_str!("../sql/006_cardtrader.sql"),
    ),
];

const CREATE_MIGRATIONS_TABLE: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (\
     name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())";

pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(CREATE_MIGRATIONS_TABLE).execute(pool).await?;

    for (name, sql) in MIGRATIONS {
        let already: Option<(String,)> =
            sqlx::query_as("SELECT name FROM schema_migrations WHERE name = $1")
                .bind(name)
                .fetch_optional(pool)
                .await?;
        if already.is_some() {
            continue;
        }

        let mut tx = pool.begin().await?;
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO schema_migrations (name) VALUES ($1)")
            .bind(name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }

    Ok(())
}

pub fn app(state: AppState) -> Router {
    let catalog: Router<AppState> = match &state.config.catalog_dir {
        Some(dir) => Router::new()
            .nest_service(
                "/v1/catalogs",
                ServeDir::new(dir).fallback(get(catalog_not_found)),
            )
            .layer(middleware::from_fn(catalog_cache)),
        None => Router::new().route("/v1/catalogs/{*path}", get(catalog_not_found)),
    };

    let allowed_origins: Vec<HeaderValue> = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, ACCEPT])
        .allow_credentials(false)
        .max_age(Duration::from_secs(86400));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/dictionary", get(dictionary))
        .merge(auth::routes())
        .merge(inventory::routes())
        .merge(stock_csv::routes())
        .merge(cardtrader::routes())
        .merge(catalog)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(RequestBodyLimitLayer::new(32 * 1024 * 1024))
        .layer(CompressionLayer::new())
        .layer(cors)
        .with_state(state)
}

async fn catalog_not_found() -> ApiError {
    ApiError::not_found("Catalog not found.")
}

async fn catalog_cache(req: Request, next: Next) -> Response {
    let index = req.uri().path().ends_with("index.json");
    let mut response = next.run(req).await;
    if response.status().is_success() {
        let value = if index {
            "public, max-age=300"
        } else {
            "public, max-age=31536000, immutable"
        };
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static(value));
    }
    response
}

async fn dictionary() -> Response {
    let mut response = (StatusCode::OK, codes::dictionary()).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    response
}

async fn healthz(State(state): State<AppState>) -> Response {
    match sqlx::query("SELECT 1").execute(&state.pool).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(err) => {
            tracing::error!(error = %err, "health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false })),
            )
                .into_response()
        }
    }
}

async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let mut response = match check_request(&state, &req) {
        Some(rejection) => rejection,
        None => next.run(req).await,
    };
    if !response.headers().contains_key(CACHE_CONTROL) {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    }
    response
}

fn check_request(state: &AppState, req: &Request) -> Option<Response> {
    let method = req.method();
    if method == Method::GET || method == Method::HEAD {
        return None;
    }

    let headers = req.headers();
    let has_authorization = headers.contains_key(AUTHORIZATION);

    if let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) {
        let allowed = state
            .config
            .allowed_origins
            .iter()
            .any(|candidate| candidate == origin);
        if !allowed && !has_authorization {
            return Some(ApiError::forbidden("Origin refused.").into_response());
        }
    }

    if method == Method::POST && req.uri().path() == "/v1/photos" {
        return None;
    }

    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let content_length = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let has_body =
        content_length > 0 || headers.contains_key(TRANSFER_ENCODING) || !content_type.is_empty();
    if has_body && !content_type.starts_with("application/json") {
        return Some(
            ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "JSON body required.")
                .into_response(),
        );
    }

    None
}
