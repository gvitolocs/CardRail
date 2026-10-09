mod common;

use common::{client, lock, login, signup, spawn};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn signup_then_me_with_bearer() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let resp = signup(&c, &base, "player@example.com", "correct horse").await;
    assert_eq!(resp.status(), 201);
    let cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(cookie.contains("cardrails_session="), "cookie: {cookie}");
    assert!(cookie.contains("HttpOnly"));

    let body: Value = resp.json().await.unwrap();
    let token = body["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(body["account"]["email"], "player@example.com");

    let me = c
        .get(format!("{base}/v1/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 200);
    let me_body: Value = me.json().await.unwrap();
    assert_eq!(me_body["account"]["email"], "player@example.com");
    assert!(me_body["account"]["createdAt"].is_string());
}

#[tokio::test]
async fn signup_duplicate_email_case_insensitive() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let first = signup(&c, &base, "A@x.io", "correct horse").await;
    assert_eq!(first.status(), 201);

    let second = signup(&c, &base, "a@x.io", "correct horse").await;
    assert_eq!(second.status(), 409);
    let body: Value = second.json().await.unwrap();
    assert_eq!(body["error"], "An account with this email already exists.");
}

#[tokio::test]
async fn login_wrong_then_right() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "user@example.com", "correct horse").await;

    let wrong = login(&c, &base, "user@example.com", "wrong horse").await;
    assert_eq!(wrong.status(), 401);
    let body: Value = wrong.json().await.unwrap();
    assert_eq!(body["error"], "Email or password is wrong.");

    let right = login(&c, &base, "user@example.com", "correct horse").await;
    assert_eq!(right.status(), 200);
    let body: Value = right.json().await.unwrap();
    assert_eq!(body["token"].as_str().unwrap().len(), 64);
}

#[tokio::test]
async fn login_rate_limited_after_ten_failures() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "rate@example.com", "correct horse").await;

    for _ in 0..10 {
        let resp = login(&c, &base, "rate@example.com", "nope nope").await;
        assert_eq!(resp.status(), 401);
    }

    let blocked = login(&c, &base, "rate@example.com", "correct horse").await;
    assert_eq!(blocked.status(), 429);
    let body: Value = blocked.json().await.unwrap();
    assert_eq!(
        body["error"],
        "Too many attempts. Wait 15 minutes and try again."
    );
}

#[tokio::test]
async fn cookie_auth_then_logout() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "cookie@example.com", "correct horse").await;

    let login_resp = login(&c, &base, "cookie@example.com", "correct horse").await;
    assert_eq!(login_resp.status(), 200);

    let me = c.get(format!("{base}/v1/auth/me")).send().await.unwrap();
    assert_eq!(me.status(), 200);

    let logout = c
        .post(format!("{base}/v1/auth/logout"))
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), 200);

    let after = c.get(format!("{base}/v1/auth/me")).send().await.unwrap();
    assert_eq!(after.status(), 401);
    let body: Value = after.json().await.unwrap();
    assert_eq!(body["error"], "Sign in to Card Rails.");
}

#[tokio::test]
async fn validation_errors() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let bad_email = signup(&c, &base, "not-an-email", "correct horse").await;
    assert_eq!(bad_email.status(), 400);
    let body: Value = bad_email.json().await.unwrap();
    assert_eq!(body["error"], "Enter a valid email address.");

    let bad_password = signup(&c, &base, "valid@example.com", "short").await;
    assert_eq!(bad_password.status(), 400);
    let body: Value = bad_password.json().await.unwrap();
    assert_eq!(body["error"], "Use a password of at least 8 characters.");
}

#[tokio::test]
async fn origin_refused_for_cookie_auth_only() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    let resp = signup(&c, &base, "origin@example.com", "correct horse").await;
    let body: Value = resp.json().await.unwrap();
    let token = body["token"].as_str().unwrap().to_string();

    let refused = c
        .post(format!("{base}/v1/auth/logout"))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
    let body: Value = refused.json().await.unwrap();
    assert_eq!(body["error"], "Origin refused.");

    let allowed = c
        .post(format!("{base}/v1/auth/logout"))
        .header("Origin", "https://evil.example")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), 200);
}

#[tokio::test]
async fn healthz_reports_ok() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();

    let resp = c.get(format!("{base}/healthz")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert!(body["ok"].as_bool().unwrap());
}

#[tokio::test]
async fn session_stores_only_token_hash() {
    let _guard = lock().await;
    let (base, pool) = spawn().await;
    let c = client();

    let resp = signup(&c, &base, "hash@example.com", "correct horse").await;
    let body: Value = resp.json().await.unwrap();
    let token = body["token"].as_str().unwrap().to_string();

    let stored: (Vec<u8>,) = sqlx::query_as("SELECT token_sha256 FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    let expected = Sha256::digest(token.as_bytes()).to_vec();
    assert_eq!(stored.0, expected);
    assert_ne!(stored.0, token.as_bytes());
}

#[tokio::test]
async fn android_client_can_sign_up_and_unknown_clients_are_refused() {
    let _guard = lock().await;
    let (base, pool) = spawn().await;
    let c = client();

    let resp = c
        .post(format!("{base}/v1/auth/signup"))
        .json(&serde_json::json!({"email": "droid@example.com", "password": "correct horse", "client": "android"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let stored: String = sqlx::query_scalar("SELECT client FROM sessions LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, "android");

    let resp = c
        .post(format!("{base}/v1/auth/signup"))
        .json(&serde_json::json!({"email": "toaster@example.com", "password": "correct horse", "client": "toaster"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}
