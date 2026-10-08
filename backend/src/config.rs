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

        Ok(Arc::new(Config {
            database_url,
            bind,
            allowed_origins,
            cookie_secure,
            catalog_dir,
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
