# Card Rails iPhone app + Rust backend — plan

Decided with the owner (2026-10-07):

- Native iPhone app (SwiftUI) that looks like the web app and scans cards into the
  Card Rails inventory in a fraction of a second, fully on-device (Core ML).
- Email + password accounts, shared by the web app and the iPhone app. The anonymous
  browser workspace (Vercel Blob, `cardrails_device` cookie) is claimed by the account on
  first login.
- Backend in **Rust** (axum 0.8 + sqlx 0.8 + tokio, same stack as `pokoin-web/pokoin-rust`),
  running in Docker on nezopt, public at `https://cardrails-api.pokoin.com` through a
  Cloudflare tunnel. The Vercel site forwards `/api/v1/*` there.
- Postgres the Pokoin way: `postgres:17-alpine` in Docker on nezopt, data under
  `/home/nez/data/cardrails-postgres/`, restart `unless-stopped`, numbered SQL migrations
  in `backend/sql/NNN_name.sql` applied with `docker exec -i … psql -v ON_ERROR_STOP=1`.
- Recognition catalogs are downloaded on demand, one small set of files per game/language.

## Recognition stack (reused from Pokoin)

| Piece | Source | iPhone form |
|---|---|---|
| Embedder | `milo_cnn.onnx` (MobileNetV2, 448×448, ImageNet mean/std, 128-d L2), sha256 `ed690f76…` | `MiloCNN.mlpackage`, fp16, normalization baked in, image input |
| Catalogs | nezopt `~/data/pokoin-scan-catalogs/catalogs-cnn-v22-allgames-20261005-backs` (live worker) | `embeddings.f16` + `cards.json` per catalog, served by the API |
| Card crop | YOLO TFLite in the old Flutter app | Apple Vision rectangle detection + `CIPerspectiveCorrection` (no TFLite) |

Crop contract: upright card crop, stretched to 448×448 bilinear. Score = cosine (dot of
L2-normalized vectors), top-k over the selected catalog.

Catalog per game/language (the art differs by language only for Pokémon and One Piece;
every other game has one `*_all` catalog and the language is picked by the user like the
condition):

| Catalog | Game | Languages |
|---|---|---|
| pokemon_western | pokemon | EN IT FR DE ES PT |
| pokemon_japanese | pokemon | JP |
| pokemon_chinese | pokemon | ZH |
| one_piece_english | one_piece | EN |
| one_piece_japanese | one_piece | JP |
| magic_all, yugioh_all, lorcana_all, riftbound_western, vanguard_all, flesh_and_blood_all, dragon_ball_super_all, digimon_all, star_wars_all, union_arena_all, gundam_all, sorcery_all, palworld_all, cyberpunk_all | per id | all |

`pokemon_generic` and `one_piece_singles` (aggregate / leftover galleries) are not shipped.

## Phases

1. Core ML conversion (`tools/coreml/`) + catalog export (`tools/catalogs/`).
2. Rust API (`backend/`): accounts, sessions, inventory, catalog file serving; Postgres
   migrations; Docker compose on nezopt; Cloudflare tunnel.
3. iPhone app (`ios/`, XcodeGen): login, scan, review, inventory; unit tests; install on
   the paired iPhone.
4. Web app: login screen, `/api/v1` forwarded to the Rust API, remaining Node endpoints
   ported to Rust (channels, listings, sync, oauth, eBay, sales, capture, photos).
