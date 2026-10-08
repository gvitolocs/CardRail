# Card Rails Inventory API — Implementation Contract

Scope: `src/engine/sync.js`, `api/v1/inventory.js`, `api/v1/sales.js`, `src/core/canonical.js`.
Owner: Card Rails. Channels are adapters, never the source of truth.

---

## 0. Hard boundary (non-negotiable)

**Forbidden**

- Firebase / ID-token bearer as the product login.
- Parsing the seller JWT to derive a uid (`uidFromKey`), or sending the seller's pasted
  Pokoin key to the server as the account identity.
- Private Pokoin seller reads:
  `marketplace-collection-summary`, `marketplace-orders?action=sold-history`,
  `marketplace-listings?sellerUid=`, `marketplace-collection`,
  `scan-session`, `scan-batch`, `scan-stream`, and any route that needs a logged-in seller.
- A private Pokoin scan session / `scan.pokoin.com/connect` pairing as Card Rails auth.
- Channel endpoint strings (URLs, `/marketplace-listings/...`) living in `src/engine`.
- Absolute quantities sent to a channel whose API expects a delta.

**Allowed**

- Pokoin **public** catalog / search / card-image reads (no seller session), cached server-side.
- Seller-authorized **channel-link** writes. A link is Card Rails-owned:
  `channel_links { sellerId, channel, externalAccountRef, credentialRef, linkedVia, linkedAt, revokedAt }`.
  `credentialRef` points at a Card Rails-scoped channel grant, never the seller's pasted Pokoin
  session token. If Pokoin exposes only private seller routes for a write today, that write stays
  queued and unimplemented until a channel grant is confirmed — do **not** fall back to private routes.

**Cardmarket rule:** Cardmarket is writable only when the seller's Pokoin account is explicitly
linked to Cardmarket, i.e. `channel_links.cardmarket.linkedVia === 'pokoin-account-link'`.
Never infer it from a token, uid, or email.

---

## 1. Canonical record (`src/core/canonical.js`)

Card Rails owns a factory + validators; connectors normalize into it and never leak channels in.

```js
InventoryItem {
  id: 'cr_<ulid>',
  identity: { game, name, setName, number },
  language: 'EN',                 // canonical 2-letter
  condition: 'NM',                // M | NM | SP | MP | PL | PO (store code, render label)
  finish: 'standard',             // standard | holo | reverse | first_edition | ...
  quantity: 3,                    // PHYSICAL TRUTH; never derived from listings
  price: 12.5, currency: 'EUR',
  location: { box, row, position },   // shelf label ONLY
  scanPhoto: null | { url, sha256, bytes, width, height, capturedAt, epsImageUrl? },
  listings: [Listing],
  version: 7,                     // optimistic concurrency
  createdAt, updatedAt
}

Listing {
  platform: 'pokoin' | 'cardtrader' | 'cardmarket' | 'ebay',
  externalId, price,
  quantity,                       // last confirmed channel quantity (mirror, not truth)
  status: 'live' | 'inactive' | 'sold_out' | 'unknown',
  stockMode: 'delta' | 'absolute',
  linkState: 'linked' | 'unlinked' | 'stale',
  lastSyncedAt, lastSyncedQuantity,
  media: { epsImageUrl, imageId, expiresAt },   // eBay
  offerId                                        // eBay
}
```

Required fixes here:

- `platformLabel` must cover `cardmarket` and `ebay` (prefer one `PLATFORMS` map).
- Add `normalizeCondition`, `normalizeFinish`, and `titleForListing(item, { maxLength: 80 })`
  (the eBay title builder, deterministic).
- `locationCode` / `locationLabel` are shelf labels; they are not a phone-pairing code.
- Canonical must not import any connector or channel URL.

---

## 2. Inventory API surface (Card Rails-owned, `api/v1`)

Server-authoritative and persisted. No handler may proxy a Pokoin private route or forward a bearer.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/inventory` | List stock (q, box, channel, status filters) |
| POST | `/api/v1/inventory` | Create row from scan/manual; **stores `scanPhoto`** |
| GET/PATCH | `/api/v1/inventory/:id` | Read; edit price/location/metadata (quantity only via `adjust`) |
| POST | `/api/v1/inventory/:id/adjust` | `{ delta, reason, idempotencyKey }` → ledger + outbox |
| GET | `/api/v1/stock-events` | Append-only ledger (the Book) |
| POST | `/api/v1/sales` | The sale transaction (see §3) |
| GET | `/api/v1/channels` | Link state per channel |
| POST/DELETE | `/api/v1/channels/:channel/link` | Explicit link; Cardmarket requires `linkedVia=pokoin-account-link` |
| POST | `/api/v1/channels/cardtrader/reconcile` | `{ complete, presentIds, exportId, confirmEmpty }` (see §6) |
| POST | `/api/v1/listings/:id/publish` | eBay publish from the stored photo + title (see §7) |
| POST | `/api/v1/capture/sessions` + SSE/poll | Card Rails-owned phone capture (replaces Pokoin scan-session/stream) |
| GET | `/api/v1/public/catalog/*` | Server proxy to Pokoin **public** catalog/search/images; cached, no client auth |

Card Rails auth is its own session (signed httpOnly cookie / device token). The Pokoin seller bearer
never crosses the browser→server boundary as identity.

---

## 3. Sale transaction ordering (`POST /api/v1/sales`)

Request: `{ channel, externalId, orderRef, lineId, quantity, occurredAt, idempotencyKey }`.

1. **Dedupe key** = `channel:orderRef:lineId` (fallback `channel:externalId:occurredAt`).
   Unique index. If a completed transaction exists, return its stored result; touch nothing.
2. **Begin transaction**, lock the inventory row (`FOR UPDATE` / optimistic `version`), find the
   `externalId` listing on `channel`.
3. **Card Rails first.** `target = max(0, item.quantity - quantity)`. Write the append-only
   `stock_event { requestedDelta: -quantity, appliedDelta: target - item.quantity, targetQuantity,
   oversell: requested - applied, channel, orderRef, lineId }`. Set `item.quantity = target`.
4. **Observe the origin channel.** Mirror the origin listing to the channel's own result
   (CardTrader already decremented). Never enqueue a write to the origin channel.
5. **Enqueue outbox rows** for every *other linked* listing:
   `outbox { key: dedupeKey + ':' + platform + ':' + externalId, platform, listingExternalId,
   targetQuantity, delta, priority }`. For Cardmarket, enqueue only if the Pokoin-account link exists;
   otherwise record `{ skipped: 'cardmarket-not-linked' }` in the event.
6. **Commit** CR state + ledger + outbox atomically. This commit *is* the sale.
7. **Deliver** outbox in channel order: `pokoin` (10) → `cardmarket` (20) → `ebay` (30) →
   `cardtrader` (40). Success stores the channel's confirmed quantity and sets `lastSyncedAt`.
   Failure → exponential backoff, then dead-letter + surface an exception. Cardmarket eligibility
   depends on the link (a static fact), not on the Pokoin push succeeding.

`delta` per listing is **not** a copy of the CR-level change. It is
`targetQuantity - listing.lastSyncedQuantity`. If the mirror is `stale`/older than the sync window,
the adapter does a **read-first** against the channel, then computes the delta. Channels already at
target get `delta = 0` and no call — this is what prevents double-decrement.

Oversell: still commit the ledger row (requested > applied), still converge channels to target 0,
and raise an exception event. A sale must never be silently dropped when stock is already 0.

---

## 4. Channel adapters and delta semantics

- **CardTrader** — `stockMode: 'delta'`. Stock change = `POST https://api.cardtrader.com/api/v2/products/{id}/increment`
  body `{ "delta_quantity": N }` (signed). Never use the absolute product update/create path for a
  sale. A CardTrader-origin sale is observed (webhook) and **not written back**. `/increment` is not
  idempotent per call, so on an ambiguous network failure do **not** blind-retry: read the product/export,
  measure actual quantity, then issue a correcting delta. Respect the 200 req/10 s limit.
- **Pokoin** — pushes go through the Card Rails channel link only; no private seller routes. If the
  Pokoin listing API is delta-based, send only the delta; if absolute, send only the CR target.
  The adapter declares `stockMode`; the engine never sends both.
- **Cardmarket** — writable only under the Pokoin-account link (§0). Missing link ⇒ intent recorded
  as blocked, no HTTP call, listing marked `stale`.
- **eBay** — quantity is absolute; adapter converts `targetQuantity`, never a raw delta. Listing
  creation/publish is per §7.

---

## 5. Idempotency

- Sale dedupe key: `channel:orderRef:lineId` (require both — no `orderRef`, no dedupe).
- Adjust: client-supplied `idempotencyKey`; unique index.
- Outbox: `saleKey:platform:listingExternalId`; a delivered key is never sent twice.
- Event ids are derived from the idempotency key (hash), not a module-level `seq`. A browser reload
  or second tab must not reuse or collide ids.
- A duplicate request returns the original result with `200`; it never writes a second ledger row.

---

## 6. Incomplete exports and reconcile

- `complete !== true` ⇒ **no writes**, audit event `skipped: 'incomplete export'`.
- `complete === true` but `presentIds.length === 0` while listings exist ⇒ treat as suspicious;
  require `confirmEmpty === true` before acting. A truncated/empty export must not zero anything.
- Reconcile only affects CardTrader **listing presence**: mark absent products `inactive`/`stale`
  locally and, if delisting, call the documented delete. It must **never** recompute Card Rails
  `quantity` from channel sums. Card Rails stock is physical truth.
- Do not send `{ product_id, absent: true }` to an export endpoint — that is not a CardTrader operation.

---

## 7. eBay listing payload and photo reuse

The scan photo is the listing photo. Reuse it; never invent a second one.

1. Photo: `item.scanPhoto`. If `epsImageUrl` is absent, publish the stored image once to EPS
   (`POST /commerce/media/v1_beta/image/createImageFromUrl` with the Card Rails HTTPS URL, or
   `createImageFromFile`), capture the `Location` image-id URI, resolve the EPS `imageUrl`, and
   persist it back onto the listing (`listing.media`). HTTPS is required; JPG/PNG are safe.
2. Exact title via `titleForListing`: `name + ' ' + setName + ' #' + number + ' ' + language +
   ' ' + finishLabel + ' ' + conditionLabel`, ASCII-folded, whitespace-collapsed, hard-clamped to
   **80 chars** with the card number preserved. Store the title + hash for idempotent re-publish.
3. `PUT /sell/inventory/v1/inventory_item/{sku}` — SKU `cr-{itemId}-{condition}-{finish}`;
   `product.title`, `product.aspects` (Game, Set, Card Number, Language, Condition, Finish),
   `product.imageUrls: [epsImageUrl]`, `condition`.
4. `POST /sell/inventory/v1/offer` (marketplaceId, format, category, price, `availableQuantity`,
   listing policies) then `POST /sell/inventory/v1/offer/{offerId}/publish`; persist `offerId`.
5. No `scanPhoto` ⇒ block publish with a clear error. Do not silently substitute catalog art.
6. Quantity updates reuse the same offer with absolute `availableQuantity` from CR.

---

## 8. Mistakes in the current `src/engine/sync.js`

1. **Private endpoints in core.** `pushFor` hardcodes `/marketplace-listings/{id}` — a Pokoin
   private seller route — and channel URLs belong in adapters, not the engine.
2. **Unknown platform falls through to Pokoin.** The final `return` is a Pokoin PATCH, so an `ebay`
   (or `cardmarket`) listing is pushed as a Pokoin listing. Concrete data corruption.
3. **Delta copied instead of per-channel convergence.** `applied` (CR-level) is added to every
   listing. If a channel already shows 0, it gets another `-1` instead of converging to target.
   No read-first, no `delta = target - channelCurrent`.
4. **No link gating.** Every existing listing is pushed regardless of `linkState`; unlinked/stale
   channels are written, and Cardmarket is not gated on the Pokoin-account relationship at all.
5. **Cardmarket absent.** `pushFor` has no cardmarket branch; a cardmarket sale is mislabeled
   (`syncSale` only special-cases `cardtrader`; everything else becomes `pokoin_sale`).
6. **Sale silently dropped at zero stock.** `if (!applied) return { item, event: null }` loses a
   real sale (oversell) with no ledger row, no Book entry, no exception.
7. **No idempotency.** `seq` is in-memory and resets; event ids collide across tabs/loads. A
   replayed webhook or re-pick double-decrements. Dedupe depends on the caller hand-setting `claim`.
8. **Reconcile corrupts CR quantity.** `Math.max(cardtraderLeft, pokoinLeft, 0)` derives physical
   stock from channel mirrors and ignores cardmarket/ebay. A complete export can zero CR stock.
9. **Reconcile push is bogus.** `POST /products/export` with `{ product_id, absent: true }` is not a
   CardTrader operation; the real delist path is the product delete/update call.
10. **Status resurrection.** `status = listingNext === 0 ? 'sold_out' : 'live'` overwrites
    `inactive`, reviving delisted listings on any stock change.
11. **Absolute quantity mixed into a delta channel.** Pokoin bodies carry `quantity_available`
    (absolute) alongside `delta_quantity`; the adapter never declares `stockMode`, so the engine
    cannot pick the right field.
12. **Client-only state.** The whole engine is pure functions over React state; a sale exists only
    in one browser tab and is lost on refresh. There is no server ledger, so ordering/idempotency
    are unenforceable.
13. **No retry/backoff/rate-limit handling** for CardTrader 429 or partial outbox failure.
14. **`syncRestock` cause is always `'cancel'`** and its channel/order semantics are untested; a
    cancellation observed on CardTrader should behave like the mirror of a sale (observe origin, push others).
15. **`api/v1/inventory.js` and `api/v1/sales.js` are forbidden proxies** to
    `marketplace-collection-summary` and `marketplace-orders?action=sold-history` using the seller bearer.

---

## 9. Patch guidance, file by file

- **`src/engine/sync.js`** — replace with a channel-agnostic reducer/emitter. `applySale` returns
  `{ item, event, intents }`; intents carry `{ channel, listingId, targetQuantity, delta, mode,
  idempotencyKey, origin, skipped? }` and **no URLs**. Preserve `inactive` status. Record
  `requestedDelta` / `appliedDelta` / `oversell`. Deterministic event ids. Delete `pushFor`'s URL strings.
- **`src/engine/` (new) `channels.js`** — channel descriptors: CardTrader (`delta`, increment URL
  builder, read-first), Pokoin (`linked` grant only), Cardmarket (`gatedBy: pokoin-account-link`),
  eBay (`absolute`, offer/publish + photo reuse). This is the only place channel endpoints live.
- **`api/v1/inventory.js`** — implement CRUD over the Card Rails store; store `scanPhoto`; no proxy.
- **`api/v1/sales.js`** — implement §3 (dedupe → ledger → commit → outbox); no `marketplace-orders`.
- **New `api/v1/stock-events.js`, `channels.js`, `reconcile.js`, `listings.js`, `capture/*`** — per §2.
- **`src/core/canonical.js`** — factory + normalizers + platform map + `titleForListing` + `scanPhoto`.
- **`src/connectors/pokoinAccount.js`** — delete `uidFromKey`, `connectPokoinAccount`'s private reads,
  `fetchScanBatch`, `startScanSession`, `renewScanPairing`, and the Pokoin `phoneConnectUrl` target.
  Keep public reads only (new `pokoinPublic.js`: catalog/search/image, no auth header).
- **`src/connectors/scanStream.js`** — repoint at the CR capture endpoint and rename the token to a
  Card Rails capture-session token; drop the Pokoin bearer.
- **`src/App.jsx`** — stop syncing in React state; call the API. Remove the `pokoinKey` bearer state
  and the Pokoin scan-session `useEffect`; remove `connectPokoinAccount` import.
- **`src/ui/Platforms.jsx`** — replace the Pokoin API-key paste with a Card Rails channel-link flow;
  show Cardmarket as "linked through Pokoin account" and eBay; render server events.
- **`src/data/demo.js`** — mark as fixtures only; do not let `samplePokoinSync`/`fromPokoinListing`
  imply a private Pokoin read shape in production paths.
- **Secrets** — channel credentials are server-only. No `VITE_`-prefixed token; `.env*` already gitignored.
