mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use common::{client, lock, signup, spawn_with};
use reqwest::Client;
use serde_json::{json, Value};

const TOKEN: &str = "test-cardtrader-token-0123456789";

type Products = Arc<Mutex<Value>>;

fn authorized(headers: &HeaderMap) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {TOKEN}"))
}

/// A CardTrader stand-in: `/info`, `/products/export`, `/expansions`.
async fn fake_cardtrader(products: Products) -> String {
    async fn info(headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
        if !authorized(&headers) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(Json(json!({ "id": 14299, "name": "Shop 1-Day Ready App", "user_id": 295975 })))
    }
    async fn export(State(p): State<Products>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
        if !authorized(&headers) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(Json(p.lock().unwrap().clone()))
    }
    async fn expansions() -> Json<Value> {
        Json(json!([{ "id": 77, "name": "Promo Boosters" }]))
    }
    let app = Router::new()
        .route("/info", get(info))
        .route("/products/export", get(export))
        .route("/expansions", get(expansions))
        .with_state(products);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn catalog() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cardrails-ct-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(dir.join("pokemon_western")).unwrap();
    std::fs::write(
        dir.join("index.json"),
        br#"{"catalogs":[{"id":"pokemon_western","game":"pokemon","languages":["EN"],"count":2,
            "embeddings":{"path":"pokemon_western/e.f16","bytes":0,"sha256":"x"},
            "cards":{"path":"pokemon_western/cards-a.json","bytes":0,"sha256":"x"}}]}"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("pokemon_western/cards-a.json"),
        br#"{"fields":["id","name","number","set","image"],"rows":[
            ["219698","Oddish","Common | 001/098","Ancient Origins","https://img/1.jpg"],
            ["219702","Gloom","2/98","Ancient Origins",null]]}"#,
    )
    .unwrap();
    dir
}

fn product(id: i64, blueprint: i64, quantity: i64, cents: i64, props: Value) -> Value {
    json!({ "id": id, "blueprint_id": blueprint, "game_id": 5, "name_en": "Booster", "quantity": quantity,
            "price_cents": cents, "price_currency": "EUR", "properties_hash": props, "expansion": { "id": 77 } })
}

async fn wait_for_sync(c: &Client, base: &str) -> Value {
    for _ in 0..100 {
        let status: Value = c.get(format!("{base}/v1/integrations/cardtrader")).send().await.unwrap().json().await.unwrap();
        let s = status["sync"]["status"].as_str().unwrap_or("");
        if s == "done" || s == "failed" {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("sync did not finish");
}

async fn compact(c: &Client, base: &str) -> Value {
    c.get(format!("{base}/v1/inventory/compact")).send().await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn cardtrader_import_mirrors_the_export_and_csv_sets_locations() {
    let _guard = lock().await;
    let products: Products = Arc::new(Mutex::new(json!([
        product(1, 109849, 2, 150, json!({ "condition": "Slightly Played", "pokemon_language": "it", "pokemon_reverse": true, "collector_number": "001/098" })),
        product(2, 109851, 1, 99, json!({ "condition": "Near Mint", "pokemon_language": "en" })),
        product(3, 555, 1, 500, json!({ "pokemon_language": "it" })),
        product(4, 109851, 1, 10, json!({ "condition": "Near Mint", "pokemon_language": "ru" })),
    ])));
    let ct = fake_cardtrader(products.clone()).await;
    let (base, _pool) = spawn_with(Some(catalog()), ct).await;
    let c = client();
    signup(&c, &base, "ct@example.com", "correct horse").await;

    let none: Value = c.get(format!("{base}/v1/integrations/cardtrader")).send().await.unwrap().json().await.unwrap();
    assert_eq!(none["connected"], false);

    let bad = c.put(format!("{base}/v1/integrations/cardtrader")).json(&json!({ "token": "wrong-token-wrong-token-wrong" })).send().await.unwrap();
    assert_eq!(bad.status(), 400);

    let ok = c.put(format!("{base}/v1/integrations/cardtrader")).json(&json!({ "token": TOKEN })).send().await.unwrap();
    assert_eq!(ok.status(), 200);
    let body: Value = ok.json().await.unwrap();
    assert_eq!(body["app"]["oneDayReady"], true);
    assert!(!body.to_string().contains(TOKEN), "token never echoed");

    let status = wait_for_sync(&c, &base).await;
    assert_eq!(status["sync"]["status"], "done", "{status}");
    let stats = &status["sync"]["stats"];
    assert_eq!((stats["created"].as_i64(), stats["notInCatalog"].as_i64(), stats["skipped"]["language"].as_i64()), (Some(3), Some(1), Some(1)));
    assert_eq!(status["copies"], 4);

    let inv = compact(&c, &base).await;
    let rows = inv["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let oddish = rows.iter().find(|r| r[1] == 219698).expect("oddish by public id");
    // [id, publicId, game, language, condition, printing, qty, cents, box, row, pos, end, version, flags]
    assert_eq!(oddish.as_array().unwrap()[2..8], [json!(1), json!(2), json!(3), json!(3), json!(2), json!(150)]);
    assert_eq!(oddish[13], 32, "cardtrader flag only");
    assert_eq!(oddish.as_array().unwrap().len(), 14, "no extras for catalog cards");
    let sealed = rows.iter().find(|r| r[1].is_null()).expect("sealed product");
    assert_eq!(sealed[5], "Sealed");
    assert_eq!(sealed[14]["n"], "Booster");
    assert_eq!(sealed[14]["s"], "Promo Boosters");
    assert_eq!(sealed[14]["b"], "555");

    // Sold one Oddish, Gloom sold out, a new product listed.
    *products.lock().unwrap() = json!([
        product(1, 109849, 1, 150, json!({ "condition": "Slightly Played", "pokemon_language": "it", "pokemon_reverse": true })),
        product(3, 555, 1, 500, json!({ "pokemon_language": "it" })),
        product(5, 109851, 3, 25, json!({ "condition": "Played", "pokemon_language": "it" })),
    ]);
    let again = c.post(format!("{base}/v1/integrations/cardtrader/sync")).send().await.unwrap();
    assert_eq!(again.status(), 202);
    let status = wait_for_sync(&c, &base).await;
    let stats = &status["sync"]["stats"];
    assert_eq!(
        (stats["created"].as_i64(), stats["updated"].as_i64(), stats["removed"].as_i64(), stats["unchanged"].as_i64()),
        (Some(1), Some(1), Some(1), Some(1)),
        "{stats}"
    );
    let inv = compact(&c, &base).await;
    let rows = inv["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let oddish = rows.iter().find(|r| r[1] == 219698).unwrap();
    assert_eq!((oddish[6].as_i64(), oddish[12].as_i64()), (Some(1), Some(2)), "quantity updated, version bumped");

    // Power Tools CSV: trailing-stack locations, matched by name/number/facets.
    let csv = "cardmarketId,quantity,name,set,setCode,cn,condition,language,isFirstEd,isReverseHolo,isSigned,finishType,price,comment,location\n\
               1,1,Oddish,Ancient Origins,AOR,1,EX,Italian,,true,,,1.5,,FUOCOBOMBA 006 - 16\n\
               2,3,Gloom,Ancient Origins,AOR,002,PL,Italian,,,,,0.25,,FUOCOBOMBA 006 - 16\n\
               3,1,Mew,151,MEW,151,NM,Italian,,,,,9,,FUOCOBOMBA 006 - 17\n";
    let preview: Value = c
        .post(format!("{base}/v1/inventory/locations/csv"))
        .json(&json!({ "csv": csv, "apply": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preview["format"], "powertools");
    assert_eq!(preview["locationParse"], "trailing_stack");
    assert_eq!((preview["matched"].as_i64(), preview["csvOnly"].as_i64(), preview["inventoryOnly"].as_i64()), (Some(2), Some(1), Some(1)));
    assert_eq!(preview["applied"], false);
    assert!(compact(&c, &base).await["boxes"].as_array().unwrap().is_empty(), "preview writes nothing");

    let applied: Value = c
        .post(format!("{base}/v1/inventory/locations/csv"))
        .json(&json!({ "csv": csv, "apply": true, "stackSize": 10, "numberedInStack": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(applied["applied"], true);
    let inv = compact(&c, &base).await;
    assert_eq!(inv["boxes"], json!(["FUOCOBOMBA 006"]));
    let gloom = inv["rows"].as_array().unwrap().iter().find(|r| r[1] == 219702).unwrap();
    // Stack 16 of 10 cards: Oddish takes 151, Gloom 152–154.
    assert_eq!((gloom[8].as_i64(), gloom[9].as_i64(), gloom[10].as_i64(), gloom[11].as_i64()), (Some(0), Some(16), Some(152), Some(154)));

    // Next sync keeps the locations it didn't set.
    c.post(format!("{base}/v1/integrations/cardtrader/sync")).send().await.unwrap();
    wait_for_sync(&c, &base).await;
    assert_eq!(compact(&c, &base).await["boxes"], json!(["FUOCOBOMBA 006"]));

    let gone = c.delete(format!("{base}/v1/integrations/cardtrader")).send().await.unwrap();
    assert_eq!(gone.status(), 200);
    let inv = compact(&c, &base).await;
    assert_eq!(inv["rows"].as_array().unwrap().len(), 3, "copies stay after disconnecting");
    assert!(inv["rows"].as_array().unwrap().iter().all(|r| r[13].as_i64().unwrap() & 32 == 0));
}
