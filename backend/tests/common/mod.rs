#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use cardrails_api::config::Config;
use cardrails_api::{app, migrate, AppState};
use reqwest::Client;
use serde_json::json;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tokio::sync::{Mutex, MutexGuard};

static DB_LOCK: Mutex<()> = Mutex::const_new(());

pub async fn lock() -> MutexGuard<'static, ()> {
    DB_LOCK.lock().await
}

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://cardrails_test:cardrails_test@127.0.0.1:25437/cardrails_test".to_string()
    })
}

pub async fn spawn() -> (String, PgPool) {
    spawn_with_catalog(None).await
}

pub async fn spawn_with_catalog(catalog_dir: Option<PathBuf>) -> (String, PgPool) {
    spawn_with(catalog_dir, "http://127.0.0.1:9".to_string()).await
}

pub async fn spawn_with(catalog_dir: Option<PathBuf>, cardtrader_url: String) -> (String, PgPool) {
    let url = test_database_url();
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect to test database");

    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&pool)
        .await
        .expect("reset schema");
    migrate(&pool).await.expect("run migrations");

    let config = Arc::new(Config {
        database_url: url,
        bind: "127.0.0.1:0".to_string(),
        allowed_origins: vec![
            "https://cardrails.vercel.app".to_string(),
            "https://scan-cardrails.vercel.app".to_string(),
        ],
        cookie_secure: false,
        catalog_dir,
        secret_key: Some([9u8; 32]),
        cardtrader_url,
        cardtrader_sync_minutes: 0,
    });
    let router = app(AppState {
        pool: pool.clone(),
        config,
    });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve app");
    });

    (format!("http://{addr}"), pool)
}

pub fn client() -> Client {
    Client::builder()
        .cookie_store(true)
        .build()
        .expect("build client")
}

pub async fn signup(c: &Client, base: &str, email: &str, password: &str) -> reqwest::Response {
    c.post(format!("{base}/v1/auth/signup"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .expect("signup request")
}

pub async fn login(c: &Client, base: &str, email: &str, password: &str) -> reqwest::Response {
    c.post(format!("{base}/v1/auth/login"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .expect("login request")
}
