mod common;

use std::path::PathBuf;

use common::{client, lock, spawn, spawn_with_catalog, signup};
use reqwest::Client;
use serde_json::{json, Value};

fn card(number: &str, quantity: i64, price: f64) -> Value {
    json!({
        "identity": {
            "game": "pokemon",
            "name": format!("Card {number}"),
            "setName": "Base Set",
            "number": number,
            "publicId": "",
            "cardtraderBlueprintId": ""
        },
        "art": "",
        "language": "EN",
        "condition": "NM",
        "printing": "Standard",
        "firstEdition": false,
        "signed": false,
        "altered": false,
        "quantity": quantity,
        "price": price
    })
}

async fn scan(
    c: &Client,
    base: &str,
    key: &str,
    intent: &str,
    cards: Vec<Value>,
) -> reqwest::Response {
    c.post(format!("{base}/v1/inventory/scans"))
        .json(&json!({ "idempotencyKey": key, "intent": intent, "cards": cards }))
        .send()
        .await
        .expect("scan request")
}

async fn configure(c: &Client, base: &str) -> reqwest::Response {
    c.put(format!("{base}/v1/inventory/settings"))
        .json(&json!({ "storageLabel": "A", "stackSize": 10 }))
        .send()
        .await
        .expect("settings request")
}

async fn inventory(c: &Client, base: &str) -> Value {
    c.get(format!("{base}/v1/inventory"))
        .send()
        .await
        .expect("inventory request")
        .json()
        .await
        .expect("inventory json")
}

#[tokio::test]
async fn new_account_has_default_inventory() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    assert_eq!(signup(&c, &base, "inv1@example.com", "correct horse").await.status(), 201);

    let body = inventory(&c, &base).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
    assert_eq!(body["scanSettings"]["game"], "pokemon");
    assert_eq!(body["scanSettings"]["language"], "EN");
    assert_eq!(body["scanSettings"]["stackSize"], Value::Null);
    assert_eq!(body["scanSettings"]["locationConfigured"], false);
    assert_eq!(body["revision"], 0);
}

#[tokio::test]
async fn scans_require_configured_location() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv2@example.com", "correct horse").await;

    let resp = scan(&c, &base, "loc-key-01", "sale", vec![card("1", 1, 1.0)]).await;
    assert_eq!(resp.status(), 400);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(
        body["error"],
        "Set a real location and stack capacity before adding cards to inventory."
    );
}

#[tokio::test]
async fn scan_allocates_locations_in_order() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv3@example.com", "correct horse").await;
    assert_eq!(configure(&c, &base).await.status(), 200);

    let resp = scan(
        &c,
        &base,
        "alloc-key-1",
        "sale",
        vec![card("1", 3, 1.0), card("2", 2, 1.0)],
    )
    .await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["location"]["box"], "A");
    assert_eq!(items[0]["location"]["row"], "1");
    assert_eq!(items[0]["location"]["position"], 1);
    assert_eq!(items[0]["location"]["end"], 3);
    assert_eq!(items[0]["location"]["stackSize"], 10);
    assert_eq!(items[1]["location"]["row"], "1");
    assert_eq!(items[1]["location"]["position"], 4);
    assert_eq!(items[1]["location"]["end"], 5);

    let resp = scan(&c, &base, "alloc-key-2", "sale", vec![card("3", 8, 1.0)]).await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["items"][0]["location"]["position"], 6);
    assert_eq!(body["items"][0]["location"]["end"], 13);
    assert_eq!(body["items"][0]["location"]["row"], "1");

    let resp = scan(&c, &base, "alloc-key-3", "sale", vec![card("4", 1, 1.0)]).await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["items"][0]["location"]["position"], 14);
    assert_eq!(body["items"][0]["location"]["end"], 14);
    assert_eq!(body["items"][0]["location"]["row"], "2");
}

#[tokio::test]
async fn repeated_idempotency_key_returns_stored_response() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv4@example.com", "correct horse").await;
    configure(&c, &base).await;

    let first = scan(&c, &base, "same-key-01", "sale", vec![card("1", 2, 3.0)]).await;
    assert_eq!(first.status(), 201);
    let first_body: Value = first.json().await.unwrap();

    let second = scan(&c, &base, "same-key-01", "sale", vec![card("1", 2, 3.0)]).await;
    assert_eq!(second.status(), 200);
    let second_body: Value = second.json().await.unwrap();
    assert_eq!(first_body, second_body);

    let body = inventory(&c, &base).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn collection_intent_forces_zero_price() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv5@example.com", "correct horse").await;
    configure(&c, &base).await;

    let resp = scan(&c, &base, "coll-key-01", "collection", vec![card("1", 4, 12.5)]).await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["items"][0]["purpose"], "collection");
    assert_eq!(body["items"][0]["price"].as_f64(), Some(0.0));
}

#[tokio::test]
async fn invalid_scans_are_rejected_without_writes() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv6@example.com", "correct horse").await;
    configure(&c, &base).await;

    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "bad-lang-001",
            {
                let mut card = card("1", 1, 1.0);
                card["language"] = json!("XX");
                card
            },
            "Choose a card language.",
        ),
        (
            "bad-cond-001",
            {
                let mut card = card("1", 1, 1.0);
                card["condition"] = json!("ZZ");
                card
            },
            "Choose a card condition.",
        ),
        (
            "bad-qty-0001",
            card("1", 0, 1.0),
            "Quantity must be a positive whole number.",
        ),
        (
            "bad-game-001",
            {
                let mut card = card("1", 1, 1.0);
                card["identity"]["game"] = json!("chess");
                card
            },
            "Choose a game.",
        ),
    ];

    for (key, bad_card, message) in cases {
        let resp = scan(&c, &base, key, "sale", vec![bad_card]).await;
        assert_eq!(resp.status(), 400, "case {key}");
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["error"], message, "case {key}");
    }

    let body = inventory(&c, &base).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn photos_upload_fetch_and_attach() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv7@example.com", "correct horse").await;
    configure(&c, &base).await;

    let rejected = c
        .post(format!("{base}/v1/photos"))
        .header("Content-Type", "image/jpeg")
        .body(b"not a jpeg".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 400);
    let body: Value = rejected.json().await.unwrap();
    assert_eq!(body["error"], "Invalid JPEG photo.");

    let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
    jpeg.resize(100, 0x00);
    let uploaded = c
        .post(format!("{base}/v1/photos"))
        .header("Content-Type", "image/jpeg")
        .body(jpeg.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(uploaded.status(), 201);
    let body: Value = uploaded.json().await.unwrap();
    let photo_id = body["id"].as_str().unwrap().to_string();
    assert!(photo_id.starts_with("photo_"));
    assert_eq!(body["bytes"], 100);
    assert_eq!(body["sha256"].as_str().unwrap().len(), 64);

    let fetched = c
        .get(format!("{base}/v1/photos/{photo_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(fetched.status(), 200);
    assert_eq!(
        fetched.headers().get("content-type").unwrap().to_str().unwrap(),
        "image/jpeg"
    );
    assert_eq!(fetched.bytes().await.unwrap().as_ref(), jpeg.as_slice());

    let other = client();
    signup(&other, &base, "inv7b@example.com", "correct horse").await;
    let hidden = other
        .get(format!("{base}/v1/photos/{photo_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 404);

    let mut missing_photo = card("9", 1, 1.0);
    missing_photo["photoId"] = json!("photo_does_not_exist");
    let resp = scan(&c, &base, "photo-key-0", "sale", vec![missing_photo]).await;
    assert_eq!(resp.status(), 400);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "Photo not found.");

    let mut with_photo = card("1", 1, 5.0);
    with_photo["photoId"] = json!(photo_id);
    let resp = scan(&c, &base, "photo-key-1", "sale", vec![with_photo]).await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(
        body["items"][0]["scanPhoto"]["url"],
        format!("/v1/photos/{photo_id}")
    );
}

#[tokio::test]
async fn patch_checks_version_and_records_event() {
    let _guard = lock().await;
    let (base, pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv8@example.com", "correct horse").await;
    configure(&c, &base).await;

    let resp = scan(&c, &base, "patch-key-01", "sale", vec![card("1", 1, 1.0)]).await;
    let body: Value = resp.json().await.unwrap();
    let item_id = body["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(body["items"][0]["version"], 1);

    let stale = c
        .patch(format!("{base}/v1/inventory/items/{item_id}"))
        .json(&json!({ "version": 999, "quantity": 5 }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 409);
    let body: Value = stale.json().await.unwrap();
    assert_eq!(
        body["error"],
        "This card changed on another device. Refresh and try again."
    );

    let patched = c
        .patch(format!("{base}/v1/inventory/items/{item_id}"))
        .json(&json!({ "version": 1, "quantity": 5 }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 200);
    let body: Value = patched.json().await.unwrap();
    assert_eq!(body["item"]["version"], 2);
    assert_eq!(body["item"]["quantity"], 5);

    let (cause, delta): (String, i32) = sqlx::query_as(
        "SELECT cause, delta FROM inventory_events WHERE item_id = $1 AND cause = 'manual_adjust'",
    )
    .bind(&item_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cause, "manual_adjust");
    assert_eq!(delta, 4);
}

#[tokio::test]
async fn delete_removes_item_and_records_event() {
    let _guard = lock().await;
    let (base, pool) = spawn().await;
    let c = client();
    signup(&c, &base, "inv9@example.com", "correct horse").await;
    configure(&c, &base).await;

    let resp = scan(&c, &base, "del-key-0001", "sale", vec![card("1", 3, 1.0)]).await;
    let body: Value = resp.json().await.unwrap();
    let item_id = body["items"][0]["id"].as_str().unwrap().to_string();

    let deleted = c
        .delete(format!("{base}/v1/inventory/items/{item_id}?version=1"))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);
    let body: Value = deleted.json().await.unwrap();
    assert_eq!(body["ok"], true);

    let body = inventory(&c, &base).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 0);

    let (cause, delta): (String, i32) = sqlx::query_as(
        "SELECT cause, delta FROM inventory_events WHERE item_id = $1 AND cause = 'removed'",
    )
    .bind(&item_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cause, "removed");
    assert_eq!(delta, -3);
}

#[tokio::test]
async fn accounts_cannot_touch_each_others_items() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let a = client();
    let b = client();
    signup(&a, &base, "isolation-a@example.com", "correct horse").await;
    signup(&b, &base, "isolation-b@example.com", "correct horse").await;
    configure(&a, &base).await;

    let resp = scan(&a, &base, "iso-key-0001", "sale", vec![card("1", 1, 1.0)]).await;
    let body: Value = resp.json().await.unwrap();
    let item_id = body["items"][0]["id"].as_str().unwrap().to_string();

    let patched = b
        .patch(format!("{base}/v1/inventory/items/{item_id}"))
        .json(&json!({ "version": 1, "quantity": 2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 404);

    let deleted = b
        .delete(format!("{base}/v1/inventory/items/{item_id}?version=1"))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 404);

    let body = inventory(&b, &base).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

fn catalog_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cardrails-catalog-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("x")).unwrap();
    std::fs::write(dir.join("index.json"), b"{\"catalogs\":[]}").unwrap();
    std::fs::write(dir.join("x/embeddings-abc.f16"), vec![1u8, 2, 3, 4]).unwrap();
    dir
}

#[tokio::test]
async fn catalog_files_are_served_without_a_session() {
    let _guard = lock().await;
    let (base, _pool) = spawn_with_catalog(Some(catalog_dir())).await;
    let c = client();

    let index = c
        .get(format!("{base}/v1/catalogs/index.json"))
        .send()
        .await
        .unwrap();
    assert_eq!(index.status(), 200);
    assert_eq!(
        index.headers().get("cache-control").unwrap().to_str().unwrap(),
        "public, max-age=300"
    );

    let embedding = c
        .get(format!("{base}/v1/catalogs/x/embeddings-abc.f16"))
        .send()
        .await
        .unwrap();
    assert_eq!(embedding.status(), 200);
    assert_eq!(
        embedding
            .headers()
            .get("cache-control")
            .unwrap()
            .to_str()
            .unwrap(),
        "public, max-age=31536000, immutable"
    );

    let traversal = c
        .get(format!("{base}/v1/catalogs/%2e%2e/Cargo.toml"))
        .send()
        .await
        .unwrap();
    assert!(
        traversal.status() == 404 || traversal.status() == 400,
        "traversal status {}",
        traversal.status()
    );
}
