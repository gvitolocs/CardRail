mod common;

use common::{client, lock, spawn, signup};
use reqwest::Method;
use serde_json::Value;

const SCAN_ORIGIN: &str = "https://scan-cardrails.vercel.app";

#[tokio::test]
async fn preflight_allows_scan_origin() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let resp = c
        .request(Method::OPTIONS, format!("{base}/v1/inventory/scans"))
        .header("Origin", SCAN_ORIGIN)
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "authorization,content-type")
        .send()
        .await
        .unwrap();

    assert!(
        resp.status() == 200 || resp.status() == 204,
        "preflight status {}",
        resp.status()
    );
    assert_eq!(
        resp.headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some(SCAN_ORIGIN)
    );
}

#[tokio::test]
async fn preflight_rejects_unknown_origin() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let resp = c
        .request(Method::OPTIONS, format!("{base}/v1/inventory/scans"))
        .header("Origin", "https://evil.example")
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "authorization,content-type")
        .send()
        .await
        .unwrap();

    assert!(
        resp.headers().get("access-control-allow-origin").is_none(),
        "unexpected allow-origin for evil origin"
    );
}

#[tokio::test]
async fn real_request_with_bearer_gets_allow_origin() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let resp = signup(&c, &base, "cors@example.com", "correct horse").await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    let token = body["token"].as_str().unwrap().to_string();

    let me = c
        .get(format!("{base}/v1/auth/me"))
        .header("Origin", SCAN_ORIGIN)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();

    assert_eq!(me.status(), 200);
    assert_eq!(
        me.headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some(SCAN_ORIGIN)
    );
}
