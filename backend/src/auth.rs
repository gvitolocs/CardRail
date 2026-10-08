use std::sync::OnceLock;

use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::{FromRequestParts, State};
use axum::http::header::{AUTHORIZATION, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::CookieJar;
use chrono::{DateTime, Duration, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::ApiError;
use crate::AppState;

const SESSION_COOKIE: &str = "cardrails_session";
const SESSION_MAX_AGE: i64 = 7_776_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/auth/signup", post(signup))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/auth/me", get(me))
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
    #[serde(default)]
    client: Option<String>,
}

pub struct Session {
    pub account_id: Uuid,
    pub email: String,
    token_sha256: Vec<u8>,
}

impl FromRequestParts<AppState> for Session {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = if let Some(token) = bearer_token(parts) {
            token
        } else {
            let jar = CookieJar::from_request_parts(parts, state)
                .await
                .unwrap_or_default();
            jar.get(SESSION_COOKIE)
                .map(|cookie| cookie.value().to_string())
                .ok_or_else(sign_in_error)?
        };

        let token_sha256 = Sha256::digest(token.as_bytes()).to_vec();
        let row: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT a.id, a.email FROM sessions s \
             JOIN accounts a ON a.id = s.account_id \
             WHERE s.token_sha256 = $1 AND s.expires_at > now()",
        )
        .bind(&token_sha256)
        .fetch_optional(&state.pool)
        .await?;
        let (account_id, email) = row.ok_or_else(sign_in_error)?;

        sqlx::query(
            "UPDATE sessions SET last_seen_at = now() \
             WHERE token_sha256 = $1 AND last_seen_at < now() - interval '10 minutes'",
        )
        .bind(&token_sha256)
        .execute(&state.pool)
        .await?;

        Ok(Session {
            account_id,
            email,
            token_sha256,
        })
    }
}

fn bearer_token(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    Some(token.trim().to_string())
}

fn sign_in_error() -> ApiError {
    ApiError::unauthorized("Sign in to Card Rails.")
}

async fn signup(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> Result<Response, ApiError> {
    let email = normalize_email(&body.email)?;
    validate_password(&body.password)?;
    let client = parse_client(body.client.as_deref())?;

    let existing: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM accounts WHERE lower(email) = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;
    if existing.is_some() {
        return Err(ApiError::conflict(
            "An account with this email already exists.",
        ));
    }

    let password_hash = hash_password(&body.password)?;
    let (account_id, created_at): (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO accounts (email, password_hash) VALUES ($1, $2) RETURNING id, created_at",
    )
    .bind(&email)
    .bind(&password_hash)
    .fetch_one(&state.pool)
    .await?;

    let token = create_session(&state, account_id, &client).await?;
    auth_response(
        StatusCode::CREATED,
        &state,
        account_id,
        email,
        created_at,
        token,
    )
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> Result<Response, ApiError> {
    let email = normalize_email(&body.email)?;
    validate_password(&body.password)?;
    let client = parse_client(body.client.as_deref())?;

    let (failures,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM auth_failures \
         WHERE email_lower = $1 AND at > now() - interval '15 minutes'",
    )
    .bind(&email)
    .fetch_one(&state.pool)
    .await?;
    if failures >= 10 {
        return Err(ApiError::too_many(
            "Too many attempts. Wait 15 minutes and try again.",
        ));
    }

    let account: Option<(Uuid, String, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT id, email, created_at, password_hash FROM accounts WHERE lower(email) = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    match account {
        Some((account_id, email, created_at, password_hash)) => {
            if verify_password(&body.password, &password_hash) {
                sqlx::query("DELETE FROM auth_failures WHERE email_lower = $1")
                    .bind(&email)
                    .execute(&state.pool)
                    .await?;
                let token = create_session(&state, account_id, &client).await?;
                auth_response(StatusCode::OK, &state, account_id, email, created_at, token)
            } else {
                record_failure(&state, &email).await?;
                Err(ApiError::unauthorized("Email or password is wrong."))
            }
        }
        None => {
            let _ = verify_password(&body.password, dummy_password_hash());
            record_failure(&state, &email).await?;
            Err(ApiError::unauthorized("Email or password is wrong."))
        }
    }
}

async fn logout(
    State(state): State<AppState>,
    session: Session,
) -> Result<Response, ApiError> {
    sqlx::query("DELETE FROM sessions WHERE token_sha256 = $1")
        .bind(&session.token_sha256)
        .execute(&state.pool)
        .await?;

    let mut response = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
    let cookie = session_cookie(&state, "", 0);
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| ApiError::internal("Something went wrong."))?,
    );
    Ok(response)
}

async fn me(State(state): State<AppState>, session: Session) -> Result<Response, ApiError> {
    let (created_at,): (DateTime<Utc>,) = sqlx::query_as("SELECT created_at FROM accounts WHERE id = $1")
        .bind(session.account_id)
        .fetch_one(&state.pool)
        .await?;

    let body = json!({
        "account": {
            "id": session.account_id,
            "email": session.email,
            "createdAt": created_at,
        }
    });
    Ok((StatusCode::OK, Json(body)).into_response())
}

fn auth_response(
    status: StatusCode,
    state: &AppState,
    account_id: Uuid,
    email: String,
    created_at: DateTime<Utc>,
    token: String,
) -> Result<Response, ApiError> {
    let body = json!({
        "account": { "id": account_id, "email": email, "createdAt": created_at },
        "token": token,
    });
    let mut response = (status, Json(body)).into_response();
    let cookie = session_cookie(state, &token, SESSION_MAX_AGE);
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| ApiError::internal("Something went wrong."))?,
    );
    Ok(response)
}

fn session_cookie(state: &AppState, token: &str, max_age: i64) -> String {
    let mut cookie =
        format!("{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}");
    if state.config.cookie_secure {
        cookie.push_str("; Secure");
    }
    cookie
}

async fn create_session(
    state: &AppState,
    account_id: Uuid,
    client: &str,
) -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let token_sha256 = Sha256::digest(token.as_bytes()).to_vec();
    let expires_at = Utc::now() + Duration::days(90);

    sqlx::query(
        "INSERT INTO sessions (token_sha256, account_id, client, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&token_sha256)
    .bind(account_id)
    .bind(client)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok(token)
}

async fn record_failure(state: &AppState, email: &str) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO auth_failures (email_lower) VALUES ($1)")
        .bind(email)
        .execute(&state.pool)
        .await?;
    Ok(())
}

fn normalize_email(raw: &str) -> Result<String, ApiError> {
    let email = raw.trim().to_lowercase();
    if email.len() < 3 || email.len() > 254 {
        return Err(invalid_email());
    }

    let mut parts = email.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    if local.is_empty() || !domain.contains('.') || parts.next().is_some() {
        return Err(invalid_email());
    }

    Ok(email)
}

fn invalid_email() -> ApiError {
    ApiError::bad_request("Enter a valid email address.")
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.len() < 8 || password.len() > 256 {
        return Err(ApiError::bad_request(
            "Use a password of at least 8 characters.",
        ));
    }
    Ok(())
}

fn parse_client(client: Option<&str>) -> Result<String, ApiError> {
    match client {
        None | Some("web") => Ok("web".to_string()),
        Some("ios") => Ok("ios".to_string()),
        Some("android") => Ok("android".to_string()),
        Some(_) => Err(ApiError::bad_request("Unknown client.")),
    }
}

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| {
            tracing::error!(error = %err, "password hashing failed");
            ApiError::internal("Something went wrong.")
        })
}

fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn dummy_password_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("cardrails-dummy-password").unwrap_or_default())
}
