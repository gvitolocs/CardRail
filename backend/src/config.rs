use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: String,
    pub allowed_origins: Vec<String>,
    pub cookie_secure: bool,
    pub catalog_dir: Option<PathBuf>,
    /// Encrypts marketplace tokens at rest; connections are refused without it.
    pub secret_key: Option<[u8; 32]>,
    pub cardtrader_url: String,
    /// Minutes between automatic CardTrader syncs; 0 turns them off.
    pub cardtrader_sync_minutes: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Arc<Config>> {
        let database_url = env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let bind = env::var("CARDRAILS_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let allowed_origins = env::var("CARDRAILS_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| {
                "https://cardrails.vercel.app,https://scan-cardrails.vercel.app".to_string()
            })
            .split(',')
            .map(|origin| origin.trim().to_string())
            .filter(|origin| !origin.is_empty())
            .collect();
        let cookie_secure = env::var("CARDRAILS_COOKIE_SECURE")
            .map(|value| value != "0")
            .unwrap_or(true);
        let catalog_dir = env::var("CARDRAILS_CATALOG_DIR")
            .ok()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);

        let secret_key = match env::var("CARDRAILS_SECRET_KEY") {
            Ok(raw) if !raw.trim().is_empty() => Some(crate::secrets::parse_key(&raw)?),
            _ => None,
        };
        let cardtrader_url = env::var("CARDRAILS_CARDTRADER_URL")
            .unwrap_or_else(|_| "https://api.cardtrader.com/api/v2".to_string())
            .trim_end_matches('/')
            .to_string();
        let cardtrader_sync_minutes = env::var("CARDRAILS_CARDTRADER_SYNC_MINUTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(15);

        Ok(Arc::new(Config {
            database_url,
            bind,
            allowed_origins,
            cookie_secure,
            catalog_dir,
            secret_key,
            cardtrader_url,
            cardtrader_sync_minutes,
        }))
    }

    pub async fn connect(&self) -> anyhow::Result<PgPool> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&self.database_url)
            .await?;
        Ok(pool)
    }
}
