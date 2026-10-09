//! Card details from a blueprint id, read from the published catalogs
//! (`CARDRAILS_CATALOG_DIR`). Lets clients send only the blueprint.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

#[derive(Clone)]
pub struct CardInfo {
    pub name: String,
    pub set: String,
    pub number: String,
    pub image: String,
}

pub type Table = Arc<HashMap<String, CardInfo>>;

/// Cards files are immutable (their name carries a content hash), so a table
/// loaded once stays valid until the index points at a new file.
fn cache() -> &'static Mutex<HashMap<PathBuf, Table>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Table>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every catalog table of one game, in index order (e.g. Pokémon western, JP, ZH).
pub fn tables_for_game(dir: &Path, game: &str) -> anyhow::Result<Vec<Table>> {
    let index: Value = serde_json::from_slice(&std::fs::read(dir.join("index.json"))?)?;
    let mut tables = Vec::new();
    for entry in index["catalogs"].as_array().into_iter().flatten() {
        if entry["game"].as_str() != Some(game) {
            continue;
        }
        let Some(path) = entry["cards"]["path"].as_str() else { continue };
        let file = dir.join(path);
        if let Some(table) = cache().lock().expect("catalog cache").get(&file) {
            tables.push(table.clone());
            continue;
        }
        let table = Arc::new(load(&file)?);
        cache().lock().expect("catalog cache").insert(file, table.clone());
        tables.push(table);
    }
    Ok(tables)
}

fn load(file: &Path) -> anyhow::Result<HashMap<String, CardInfo>> {
    let root: Value = serde_json::from_slice(&std::fs::read(file)?)?;
    let fields: Vec<&str> = root["fields"]
        .as_array()
        .map(|f| f.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let at = |name: &str| fields.iter().position(|f| *f == name);
    let (id, name, number, set, image) = (at("id"), at("name"), at("number"), at("set"), at("image"));
    let text = |row: &Vec<Value>, index: Option<usize>| -> String {
        index
            .and_then(|i| row.get(i))
            .and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string())))
            .unwrap_or_default()
    };
    let mut table = HashMap::new();
    for row in root["rows"].as_array().into_iter().flatten() {
        let Some(row) = row.as_array() else { continue };
        let key = text(row, id);
        if key.is_empty() {
            continue;
        }
        table.insert(
            key,
            CardInfo {
                name: text(row, name),
                set: text(row, set),
                number: text(row, number),
                image: text(row, image),
            },
        );
    }
    Ok(table)
}
