/// jemalloc hands freed memory back to the OS; glibc kept ~2 GB after a 50k-card load test.
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

use std::sync::Arc;

use cardrails_api::config::Config;
use cardrails_api::{app, migrate, AppState};
use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env()?;
    let pool = config.connect().await?;
    migrate(&pool).await?;

    let state = AppState {
        pool,
        config: Arc::clone(&config),
    };
    if config.cardtrader_sync_minutes > 0 && config.secret_key.is_some() {
        cardrails_api::cardtrader::spawn_scheduler(
            state.clone(),
            std::time::Duration::from_secs(config.cardtrader_sync_minutes * 60),
        );
    }
    let router = app(state);

    let listener = TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, "cardrails-api listening");

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.ok();
    };

    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(err) => tracing::error!(error = %err, "failed to install SIGTERM handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
