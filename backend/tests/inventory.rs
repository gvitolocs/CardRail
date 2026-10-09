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


fn import_catalog_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cardrails-import-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("pokemon_western")).unwrap();
    std::fs::write(
        dir.join("index.json"),
        br#"{"catalogs":[{"id":"pokemon_western","game":"pokemon","languages":["EN"],"count":2,
            "embeddings":{"path":"pokemon_western/embeddings-a.f16","bytes":0,"sha256":"x"},
            "cards":{"path":"pokemon_western/cards-a.json","bytes":0,"sha256":"x"}}]}"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("pokemon_western/cards-a.json"),
        br#"{"fields":["id","name","number","set","image"],"rows":[["219698","Oddish","1/98","Ancient Origins","https://img/1.jpg"],["219702","Gloom",null,"Ancient Origins",null]]}"#,
    )
    .unwrap();
    dir
}

async fn compact(c: &Client, base: &str) -> Value {
    c.get(format!("{base}/v1/inventory/compact"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn compact_inventory_is_lossless_and_sorted_by_shelf() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let c = client();
    signup(&c, &base, "compact@example.com", "correct horse").await;
    assert_eq!(configure(&c, &base).await.status(), 200);

    let mut with_blueprint = card("7", 2, 3.5);
    with_blueprint["identity"]["publicId"] = json!("219698");
    with_blueprint["signed"] = json!(true);
    with_blueprint["language"] = json!("IT");
    let resp = scan(&c, &base, "compact-key", "sale", vec![with_blueprint, card("8", 1, 1.0)]).await;
    assert_eq!(resp.status(), 201);

    let full = inventory(&c, &base).await;
    let items = full["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let manual = items.iter().find(|i| i["identity"]["name"] == "Card 8").unwrap();
    assert!(manual["createdAt"].as_str().unwrap().ends_with('Z'));
    let priced = items.iter().find(|i| i["identity"]["publicId"] == "219698").unwrap();
    assert_eq!(priced["price"], 3.5);

    let compact = compact(&c, &base).await;
    assert_eq!(compact["boxes"], json!(["A"]));
    let fields: Vec<&str> = compact["fields"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
    let at = |row: &Value, name: &str| row[fields.iter().position(|f| *f == name).unwrap()].clone();
    let rows = compact["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    // Shelf order: positions 1-2, then 3.
    let first = &rows[0];
    assert_eq!(first.as_array().unwrap().len(), fields.len(), "blueprint rows carry no extras");
    assert_eq!(at(first, "publicId"), 219698);
    assert_eq!(at(first, "game"), 1);
    assert_eq!(at(first, "language"), 2);
    assert_eq!(at(first, "condition"), 2);
    assert_eq!(at(first, "printing"), 1);
    assert_eq!(at(first, "priceCents"), 350);
    assert_eq!(at(first, "box"), 0);
    assert_eq!(at(first, "row"), 1);
    assert_eq!(at(first, "position"), 1);
    assert_eq!(at(first, "end"), 2);
    assert_eq!(at(first, "flags"), 2);
    // The compact id is the numeric seq; PATCH accepts it in place of the cr_ id.
    let seq = at(first, "id").as_i64().expect("numeric seq id");
    let patched = c
        .patch(format!("{base}/v1/inventory/items/{seq}"))
        .json(&json!({ "version": at(first, "version"), "price": 4.0 }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 200);
    let patched: Value = patched.json().await.unwrap();
    assert_eq!(patched["item"]["id"], priced["id"]);
    let second = rows[1].as_array().unwrap();
    assert_eq!(second.len(), fields.len() + 1, "manual copies carry their details");
    assert_eq!(at(&rows[1], "publicId"), Value::Null);
    assert_eq!(at(&rows[1], "position"), 3);
    assert_eq!(second[fields.len()]["n"], "Card 8");
    assert_eq!(second[fields.len()]["k"], "8");
    assert_eq!(compact["revision"].as_i64().unwrap() + 1, patched["revision"].as_i64().unwrap());
}

#[tokio::test]
async fn dictionary_is_public_and_stable() {
    let _guard = lock().await;
    let (base, _pool) = spawn().await;
    let resp = client().get(format!("{base}/v1/dictionary")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("cache-control").unwrap().to_str().unwrap(), "public, max-age=86400");
    let dict: Value = resp.json().await.unwrap();
    assert_eq!(dict["version"], 1);
    assert_eq!(dict["languages"]["1"], "EN");
    assert_eq!(dict["languages"]["2"], "IT");
    assert_eq!(dict["languages"]["5"], "JP");
    assert_eq!(dict["conditions"]["2"], "NM");
    assert_eq!(dict["games"]["4"], "one_piece");
    assert_eq!(dict["flags"]["8"], "collection");
}

#[tokio::test]
async fn compact_import_resolves_blueprints_and_allocates() {
    let _guard = lock().await;
    let (base, _pool) = spawn_with_catalog(Some(import_catalog_dir())).await;
    let c = client();
    signup(&c, &base, "import@example.com", "correct horse").await;
    assert_eq!(configure(&c, &base).await.status(), 200);

    let import = |key: &str, rows: Value| {
        let c = c.clone();
        let url = format!("{base}/v1/inventory/import");
        let body = json!({ "idempotencyKey": key, "intent": "sale", "rows": rows });
        async move { c.post(url).json(&body).send().await.unwrap() }
    };

    let unknown = import("import-key-0", json!([[999, 1, 1, 2, 1, 1, 100, 0]])).await;
    assert_eq!(unknown.status(), 400);
    assert!(unknown.text().await.unwrap().contains("pokemon/999"));

    let ok = import("import-key-1", json!([[219698, 1, 2, 2, 2, 3, 250, 1], ["219702", 1, 1, 3, "Cosmos Holo", 1, 99, 8]])).await;
    assert_eq!(ok.status(), 201);
    let body: Value = ok.json().await.unwrap();
    assert_eq!(body["imported"], 2);
    let again: Value = import("import-key-1", json!([[219698, 1, 1, 2, 1, 1, 0, 0]])).await.json().await.unwrap();
    assert_eq!(again, body, "same idempotency key returns the stored response");

    let full = inventory(&c, &base).await;
    let items = full["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let oddish = items.iter().find(|i| i["identity"]["publicId"] == "219698").unwrap();
    assert_eq!(oddish["identity"]["name"], "Oddish");
    assert_eq!(oddish["identity"]["setName"], "Ancient Origins");
    assert_eq!(oddish["identity"]["number"], "1/98");
    assert_eq!(oddish["art"], "https://img/1.jpg");
    assert_eq!(oddish["language"], "IT");
    assert_eq!(oddish["printing"], "Holo");
    assert_eq!(oddish["firstEdition"], true);
    assert_eq!(oddish["price"], 2.5);
    assert_eq!(oddish["source"], "import");
    assert_eq!(oddish["location"]["position"], 1);
    assert_eq!(oddish["location"]["end"], 3);
    let gloom = items.iter().find(|i| i["identity"]["publicId"] == "219702").unwrap();
    assert_eq!(gloom["printing"], "Cosmos Holo");
    assert_eq!(gloom["condition"], "SP");
    assert_eq!(gloom["purpose"], "collection");
    assert_eq!(gloom["price"], 0.0);
    assert_eq!(gloom["location"]["position"], 4);

    let rows = compact(&c, &base).await["rows"].as_array().unwrap().clone();
    assert!(rows.iter().all(|r| r.as_array().unwrap().len() == 14), "imported blueprint rows carry no extras");
    assert_eq!(rows[0][13], 16 + 1, "imported + first edition flags");

    let bad = import("import-key-2", json!([[219698, 99, 1, 2, 1, 1, 0, 0]])).await;
    assert_eq!(bad.status(), 400);
}
