# Card Rails implementation

Card Rails owns its inventory, stock book and scan photos without a Pokoin login. Production target: https://cardrails.vercel.app. No demo inventory is loaded.

## Capture and persistence

The scan desk captures a phone upload or live camera frame, converts it to a JPEG, and uploads directly from the browser to `api.pokoin.com/api/scan/identify` with `credentials: omit`, Pokoin’s **public**, unauthenticated recognition API. This avoids a failed Vercel relay observed during production verification. Dashboard and Scan Pokémon reproduce the full scan desk structure with a dark background and red accents: a visible phone pairing panel with large QR, code and countdown, sale/collection mode, shared batch defaults, public catalog search and all editable queue columns. Defaults include game, language, condition, finish, first edition/signed/altered flags, box label, cards per stack, stack and start position, and merge repeats. Queue rows merge only when identity and variant metadata match, retaining the original saved scan photo. Manual catalog rows have catalog art and no fabricated scan photo. Recognition saves its photo/result separately from inventory stock; public catalog search also runs directly in the browser without cookies because the Vercel server relay was refused during production verification; a browser recognition network failure retries once, then falls back to Card Rails' own public-recognition relay. Correction is available for unmatched scans.

Batch confirmation saves sale inventory or a separate collection purpose atomically. Collection hides price and cannot be sold or published. Shelf allocation reserves one physical position per copy against current inventory, including transitions across stacks. Removal supports undo. Keyboard help covers search, confirmation and closing panels. Destination controls show Card Rails, Pokoin and CardTrader; direct batch publication to those external marketplaces remains unavailable. CardTrader can be connected and exact listings mapped from Inventory. No external publication is fabricated.

Inventory and photos are in the private Vercel Blob store `cardrail-inventory`. A random 256-bit HttpOnly, SameSite=Lax, production Secure cookie is the first-party workspace capability; its SHA-256 hash is the storage path. SameSite=Lax supports eBay’s OAuth return, while JSON mutation endpoints verify origin. Clearing all paired devices’ cookies loses access; account recovery/export is not yet implemented.

Updates use ETag conditional writes and rebase failed writes on the latest workspace. JSON reads use identity encoding to preserve a strong conditional-write ETag. Photos are private, content-addressed objects; `/api/v1/photo` checks inventory or staged-queue ownership before serving bytes. IndexedDB is a convenience cache, not the stock authority.

Phone pairing is owned by Card Rails. `/connect` accepts the displayed four-digit code and creates a two-minute request that the inventory owner must approve on the desktop; code knowledge alone never grants access. The phone polls a separate random request secret and receives the shared cookie only after approval. QR links retain their independent random secret and one-use validation. A QR contains a random secret in the URL fragment and a four-digit pairing code, expires after ten minutes, and can be consumed once using conditional deletion. The phone receives the first-party workspace cookie; it never visits Pokoin’s private pairing/login routes. Paired desktops refresh inventory every five seconds.

## Stock and channels

A sale deducts canonical stock, appends the Book entry and queues other connected listings atomically. Dedupe uses channel, order reference and line reference. Oversells produce an exception event. Pending targets are superseded; confirmed mirrors advance only after a real API response or seller export. Origin quantities are marked stale until read; an observed CardTrader sale never sends a decrement back to CardTrader.

CardTrader connection verifies `/api/v2/info` and encrypts its API token/shared secret with AES-256-GCM. Existing listings are selected from the seller’s actual product export; mapping quantity is re-read on the server. Delivery reads fresh products and recomputes `target - remote`, then uses **POST `/products/:id/increment` with `delta_quantity`**. It never uses an absolute quantity update. Missing or malformed exports preserve Card Rails stock. A missing listing is an actionable delivery error; it is not automatically recreated. The API supports creation only with explicit blueprint variant properties, and that path is not exposed in the current UI.

Delivery has a workspace lease, runs after sales/stock adjustments, and checks orders before delivery. While the app is visible, connected channels are checked every minute. Platforms also has a manual check. Each card’s delivery order is Pokoin, then linked Cardmarket, then CardTrader/eBay. A failed earlier channel blocks later channels for that card. Results/errors remain visible in Inventory and Platforms.

CardTrader’s signed webhook receiver checks the exact raw body’s HMAC-SHA256 `Signature` using the application’s shared secret, then retrieves actual seller orders. A seller can enable it in Platforms using a dedicated Card Rails API application. Another application’s existing webhook is never overwritten. eBay sales are currently polled; background eBay notification/cron processing is not implemented.

### Pokoin / Cardmarket: an upstream prerequisite remains

Pokoin’s public catalog/search/recognition work. No existing Card Rails-scoped seller grant endpoint was found in the Pokoin API. Therefore Pokoin seller writes and Cardmarket linking are **unavailable in production**, displayed as such. Private seller reads, Firebase/session bearers and Pokoin scan sessions are not fallback paths.

`POKOIN_CARDRAILS_CONNECTOR_URL` is a future connector contract, not an existing route. When an actual HTTPS `/api/cardrails/…` endpoint is deployed on Pokoin, it must verify an explicitly seller-approved, revocable `cardrails:stock` grant and return the account reference plus a verified Cardmarket link. Its `stock` response must acknowledge the specific listing and quantity; sale responses must identify mapped rows/order lines. Card Rails sends separate ordered intents, including Cardmarket, rather than asking Pokoin to decide or fan out stock changes. See the original boundary in `inventory-api-contract.md`. Merely configuring a URL or account reference cannot create a connected status.

This missing service cannot be completed by calling a private Pokoin API. Deploying an upstream Pokoin change is a separate release from the authorized Card Rails deployment. No files in Pokoin’s canonical checkout were changed.

## eBay listing flow

The seller connects through OAuth or a verified seller access token. OAuth application credentials can be configured from Platforms or through `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REDIRECT_URI` (RuName). Tokens and developer application secrets are encrypted before persistence and removed from every inventory response. OAuth validates a short-lived one-use state bound to this workspace and refreshes seller tokens when needed. Register `https://cardrails.vercel.app/api/v1/oauth` as the application’s accepted redirect URL.

Inventory’s card drawer loads actual seller shipping locations and payment, fulfillment and return policies. The seller reviews title, variant, price, quantity, policies and the original scan, then explicitly publishes that card. Category 183454 uses the ungraded CCG condition descriptor. Title validation keeps name, set, number, language, condition and finish; it rejects overlong titles rather than silently dropping identity details.

Publication reads the **saved photo bytes**, sends them to eBay’s current Media API `create_image_from_file` as multipart `image`, and inserts the returned EPS URL into the Inventory item. It creates/reuses an offer, persists the offer ID before publication, and saves the confirmed listing ID. Retry recovers an already published offer. A stock change during publication queues convergence afterward. No catalog-image substitution or second photo occurs. Existing live listings cannot change card variant accidentally.

No live seller accounts were provided in this session. Real eBay publication and real CardTrader writes were therefore verified against injected API responses, not performed against somebody’s seller account.

## Runtime routes

- `inventory`: GET workspace; POST stage-scan/stage-catalog/scan-defaults/edit-scan/remove-scan/restore-scan/commit-scans plus create/adjust/edit/listing/pick/reconcile operations with an idempotency key.
- `sales`: POST atomic stock/Book/outbox transaction, followed by channel delivery.
- `photo`: GET the private saved scan.
- `catalog`, `recognize`: public Pokoin search/recognition, no seller authorization.
- `capture`: POST first-party phone pairing create/consume.
- `channels`: verified connections, actual listing/policy reads, webhook enable/disconnect.
- `sync`: POST observe orders and deliver queued targets.
- `listings`: POST preview or actual publish from the saved photo.
- `oauth`: encrypted eBay application setup and OAuth initiation/callback.
- `hooks`: raw-body signed CardTrader notification receiver.
- `ebay`: legacy downloadable draft payload containing the same saved scan.

## Configuration and verification

`BLOB_READ_WRITE_TOKEN` and `CARDRAILS_ENCRYPTION_KEY` are configured on production/development. Keep the encryption key stable; changing it makes existing encrypted grants unreadable. Never expose it to Vite’s client variables. No tokens are printed or committed.

Run `npm test`, `npm run lint`, `npm run build`. Focused tests cover encrypted credentials/public projection, public recognition, fresh CardTrader deltas, origin-sale dedupe/no echo, missing exports, delivery ordering/failure, exact eBay uploaded bytes and policy payloads, publication retry and raw webhook signatures. The Playwright callback `tests/browser-reference.cjs` checks automatic QR creation, typed-code owner approval, shared phone capture, live public catalog additions, duplicate merge, flags, pile positions, undo, separate collection, real recognition, edited scan confirmation and reload persistence. Queue unit tests cover staging without stock changes, batch edits, current shelf allocation, unidentified-card validation, removal and idempotency. `tests/qr-check.cjs` captures the QR; OpenCV decoded it successfully. Browser tests use isolated cookies and do not change a user’s workspace.

Qwen drafted the scan/review, camera, drawer and connection UI. Its invented grant flows, grading options and dummy publication were rejected. DeepSeek’s earlier contract/review exposed premature mirror acknowledgement and unverified links; the implementation fixes those. An additional review attempt timed out, so it is not claimed as completed. Zcode was not given a GUI task and is not claimed as a reviewer.

Official API references: [CardTrader](https://www.cardtrader.com/en-US/docs/api/full/reference), [eBay current image uploads](https://developer.ebay.com/api-docs/sell/static/inventory/managing-image-media.html), [eBay offer requirements](https://developer.ebay.com/api-docs/sell/static/inventory/publishing-offers.html).
