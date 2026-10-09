import { useEffect, useRef, useState } from "react";
import {
  displayPhoto,
  eur,
  locationCode,
  platformLabel,
  listingTitle,
} from "../core/canonical.js";
import { CardTraits } from "./CardTraits.jsx";
import { request } from "../services/api.js";
export function Inventory({
  items,
  query,
  links,
  busy,
  onAdjust,
  onSell,
  onMap,
  onEdit,
  onPublish,
  onSync,
  intakeOnly,
  onShowAll,
}) {
  const [ownership, setOwnership] = useState("sale");
  const [selected, setSelected] = useState(null),
    [mode, setMode] = useState("detail"),
    [channel, setChannel] = useState("rail"),
    [orderRef, setOrderRef] = useState(""),
    [lineId, setLineId] = useState(""),
    [quantity, setQuantity] = useState(1),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [products, setProducts] = useState([]),
    [productId, setProductId] = useState(""),
    [policies, setPolicies] = useState(null),
    [settings, setSettings] = useState({}),
    [edit, setEdit] = useState({});
  const publicationKey = useRef(""),
    closeButton = useRef(null);
  const item = items.find((row) => row.id === selected);
  useEffect(() => {
    if (!selected) return;
    closeButton.current?.focus();
    function escape(event) {
      if (event.key === "Escape") setSelected(null);
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected]);
  const needle = query.toLowerCase(),
    visible = items.filter(
      (row) =>
        (!intakeOnly || ["scan", "catalog"].includes(row.source)) &&
        (row.purpose || "sale") === ownership &&
        [
          row.identity.name,
          row.identity.setName,
          row.identity.number,
          locationCode(row.location),
          row.language,
          row.condition,
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  function open(row, nextMode = "detail") {
    setSelected(row.id);
    setMode(nextMode);
    setChannel("rail");
    setOrderRef("");
    setLineId("");
    setQuantity(1);
    setError("");
    setPolicies(null);
    setProducts([]);
    setProductId("");
    setSettings({});
    setEdit({
      price: row.price,
      language: row.language,
      condition: row.condition,
      printing: row.printing,
      box: row.location?.verified === false ? "" : row.location?.box || "",
      row: row.location?.verified === false ? "" : row.location?.row || "",
      position: row.location?.verified === false ? "" : row.location?.position || "",
    });
    publicationKey.current = crypto.randomUUID();
  }
  async function run(work) {
    setWorking(true);
    setError("");
    try {
      return await work();
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setWorking(false);
    }
  }
  async function loadProducts() {
    setMode("mapping");
    await run(async () => {
      const data = await request(
        `channels?action=cardtrader-products${item.identity.cardtraderBlueprintId ? "&blueprint=" + encodeURIComponent(item.identity.cardtraderBlueprintId) : ""}`,
      );
      setProducts(data.products);
    });
  }
  async function prepareEbay() {
    setMode("ebay");
    await run(async () => {
      const data = await request("channels?action=ebay-settings");
      setPolicies(data);
      setSettings({
        merchantLocationKey: data.locations[0]?.merchantLocationKey || "",
        paymentPolicyId: data.paymentPolicies[0]?.paymentPolicyId || "",
        fulfillmentPolicyId:
          data.fulfillmentPolicies[0]?.fulfillmentPolicyId || "",
        returnPolicyId: data.returnPolicies[0]?.returnPolicyId || "",
        title: listingTitle(item, Infinity),
      });
    });
  }
  async function sale(event) {
    event.preventDefault();
    if (
      await run(() =>
        onSell(item.id, channel, Number(quantity), orderRef, lineId),
      )
    )
      setMode("detail");
  }
  async function saveEdit(event) {
    event.preventDefault();
    const saved = await run(() =>
      onEdit(item.id, {
        price: Number(edit.price),
        language: edit.language,
        condition: edit.condition,
        printing: edit.printing,
        location: {
          box: edit.box,
          row: edit.row,
          position: Number(edit.position),
        },
      }),
    );
    if (saved) setMode("detail");
  }
  return (
    <section>
      <p className="kicker">Stock rail</p>
      <div className="inventory-heading">
        <div>
          <h1 className="page-title">Every card. In its place.</h1>
          <p className="page-sub">
            {items.length} inventory rows · photos, variants, shelf positions
            and channel stock.
          </p>
        </div>
        <button
          className="btn"
          disabled={
            busy ||
            !Object.values(links).some((link) => link.status === "connected")
          }
          onClick={onSync}
        >
          Sync stock
        </button>
      </div>
      <div className="row-actions" role="group" aria-label="Inventory mode">
        <button
          className="btn"
          aria-pressed={ownership === "sale"}
          onClick={() => setOwnership("sale")}
        >
          For sale
        </button>
        <button
          className="btn"
          aria-pressed={ownership === "collection"}
          onClick={() => setOwnership("collection")}
        >
          Collection
        </button>
      </div>
      {intakeOnly && (
        <button className="btn btn-small" onClick={onShowAll}>
          Show all cards
        </button>
      )}
      <div className="table-scroll">
        <table className="stock-table">
          <thead>
            <tr>
              <th>Card</th>
              <th>Location</th>
              <th>Stock</th>
              <th>Price</th>
              <th>Channels</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!visible.length && (
              <tr>
                <td colSpan={6} className="inventory-empty">
                  Your rail is ready. Add your first card in Scan.
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <tr key={row.id} className={row.quantity === 0 ? "is-out" : ""}>
                <td>
                  <button className="inventory-card" onClick={() => open(row)}>
                    <img
                      src={displayPhoto(row)}
                      alt={`Saved scan of ${row.identity.name}`}
                    />
                    <span>
                      <strong>{row.identity.name}</strong>
                      <small>
                        {row.identity.setName} · #{row.identity.number}
                      </small>
                      <CardTraits item={row} />
                    </span>
                  </button>
                </td>
                <td>
                  <span className="shelf-pill">
                    {locationCode(row.location)}
                  </span>
                </td>
                <td>
                  <div className="stock-controls">
                    <button
                      className="btn btn-small"
                      aria-label={`Remove one ${row.identity.name}`}
                      disabled={busy || !row.quantity}
                      onClick={() => onAdjust(row.id, -1)}
                    >
                      −
                    </button>
                    <b>{row.quantity}</b>
                    <button
                      className="btn btn-small"
                      aria-label={`Add one ${row.identity.name}`}
                      disabled={busy}
                      onClick={() => onAdjust(row.id, 1)}
                    >
                      +
                    </button>
                  </div>
                </td>
                <td>{eur(row.price)}</td>
                <td>
                  <div className="listing-states">
                    {row.listings.length ? (
                      row.listings.map((listing) => (
                        <span
                          className={"src src-" + listing.platform}
                          key={listing.platform}
                        >
                          {platformLabel(listing.platform)} ·{" "}
                          {listing.syncStatus}
                        </span>
                      ))
                    ) : (
                      <span className="muted">
                        {row.purpose === "collection"
                          ? "In collection"
                          : "Ready to list"}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <button className="btn btn-small" onClick={() => open(row)}>
                    Open card
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {item && (
        <div
          className="drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <aside
            className="card-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={item.identity.name}
          >
            <button
              ref={closeButton}
              className="drawer-close btn"
              onClick={() => setSelected(null)}
            >
              Close ×
            </button>
            <div className="drawer-card">
              <img
                src={displayPhoto(item)}
                alt={`Saved photo of ${item.identity.name}`}
              />
              <div>
                <p className="kicker">{locationCode(item.location)}</p>
                <h2>{item.identity.name}</h2>
                <p>
                  {item.identity.setName} · #{item.identity.number}
                </p>
                <CardTraits item={item} />
                <p>
                  <b>{item.quantity} in stock</b> · {eur(item.price)}
                </p>
              </div>
            </div>
            <div className="row-actions">
              {item.purpose !== "collection" && (
                <button className="btn" onClick={() => setMode("sale")}>
                  Record sale
                </button>
              )}
              <button className="btn" onClick={() => setMode("edit")}>
                Edit card / shelf
              </button>
              {item.purpose !== "collection" &&
                links.cardtrader?.status === "connected" && (
                  <button
                    className="btn"
                    disabled={working}
                    onClick={loadProducts}
                  >
                    Link CardTrader listing
                  </button>
                )}
              {item.purpose !== "collection" &&
                item.scanPhoto &&
                links.ebay?.status === "connected" &&
                !item.listings.some(
                  (l) => l.platform === "ebay" && l.status === "live",
                ) && (
                  <button
                    className="btn btn-primary"
                    disabled={working || !item.quantity}
                    onClick={prepareEbay}
                  >
                    List on eBay
                  </button>
                )}
            </div>
            {error && (
              <p className="capture-error" role="alert">
                {error}
              </p>
            )}
            {mode === "detail" && (
              <div className="drawer-status">
                <h3>Channel stock</h3>
                {!item.listings.length && (
                  <p>
                    Connect a seller account in Platforms, then link or publish
                    this card.
                  </p>
                )}
                {item.listings.map((listing) => (
                  <div key={listing.platform}>
                    <b>{platformLabel(listing.platform)}</b>
                    <span>
                      {listing.lastSyncedQuantity ?? "—"} last confirmed ·{" "}
                      {listing.syncStatus}
                    </span>
                    {listing.lastSyncedAt && (
                      <small>
                        {new Date(listing.lastSyncedAt).toLocaleString()}
                      </small>
                    )}
                    {listing.syncError && (
                      <p className="capture-error">{listing.syncError}</p>
                    )}
                    {listing.url && (
                      <a href={listing.url} target="_blank" rel="noreferrer">
                        Open live listing
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
            {mode === "sale" && (
              <form className="capture-form" onSubmit={sale}>
                <h3 className="wide">Record a sold card</h3>
                <label>
                  Sale channel
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                  >
                    <option value="rail">Card Rails</option>
                    {item.listings
                      .filter((l) => links[l.platform]?.status === "connected")
                      .map((l) => (
                        <option value={l.platform} key={l.platform}>
                          {platformLabel(l.platform)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Sold quantity
                  <input
                    required
                    type="number"
                    min="1"
                    step="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </label>
                <label>
                  Order reference
                  <input
                    required
                    value={orderRef}
                    onChange={(e) => setOrderRef(e.target.value)}
                  />
                </label>
                <label>
                  Line reference
                  <input
                    required
                    value={lineId}
                    onChange={(e) => setLineId(e.target.value)}
                  />
                </label>
                <button className="btn btn-primary" disabled={busy || working}>
                  Save sale & sync
                </button>
              </form>
            )}
            {mode === "edit" && (
              <form className="capture-form" onSubmit={saveEdit}>
                <h3 className="wide">Edit card & shelf</h3>
                {[
                  "price",
                  "language",
                  "condition",
                  "printing",
                  "box",
                  "row",
                  "position",
                ].map((key) => (
                  <label key={key}>
                    {
                      {
                        price: "Price (€)",
                        language: "Language",
                        condition: "Condition",
                        printing: "Finish",
                        box: "Box",
                        row: "Row",
                        position: "Position",
                      }[key]
                    }
                    <input
                      type={
                        ["price", "position"].includes(key) ? "number" : "text"
                      }
                      required
                      value={edit[key]}
                      onChange={(e) =>
                        setEdit((previous) => ({
                          ...previous,
                          [key]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
                <p className="wide">
                  Variant edits change this inventory row. Existing marketplace
                  variants must be reviewed before relisting.
                </p>
                <button className="btn btn-primary" disabled={busy || working}>
                  Save changes
                </button>
              </form>
            )}
            {mode === "mapping" && (
              <form
                className="capture-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const product = products.find((p) => p.id === productId);
                    if (
                      product &&
                      (await onMap({
                        id: item.id,
                        channel: "cardtrader",
                        externalId: product.id,
                        confirmedQuantity: product.quantity,
                      }))
                    ) {
                      setMode("detail");
                    }
                  });
                }}
              >
                <h3 className="wide">Choose the exact CardTrader listing</h3>
                <label className="wide">
                  Your live products
                  <select
                    required
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                  >
                    <option value="">Choose listing</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name} · {JSON.stringify(product.properties)} ·
                        stock {product.quantity} · #{product.id}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="wide">
                  Confirm language, condition and finish match this card. Card
                  Rails reads its quantity from CardTrader; your inventory
                  quantity stays authoritative.
                </p>
                <button
                  className="btn btn-primary"
                  disabled={busy || working || !productId}
                >
                  Link listing & sync stock
                </button>
              </form>
            )}
            {mode === "ebay" && (
              <form
                className="capture-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    if (
                      await onPublish({
                        itemId: item.id,
                        channel: "ebay",
                        settings,
                        idempotencyKey: publicationKey.current,
                      })
                    )
                      setMode("detail");
                  });
                }}
              >
                <h3 className="wide">Review & publish on eBay</h3>
                <label className="wide">
                  Precise title
                  <input
                    required
                    maxLength={80}
                    value={settings.title || ""}
                    onChange={(e) =>
                      setSettings((previous) => ({
                        ...previous,
                        title: e.target.value,
                      }))
                    }
                  />
                </label>
                <p className="wide">
                  {(settings.title || "").length}/80 characters ·{" "}
                  {item.quantity} copies · {eur(item.price)} each ·{" "}
                  {links.ebay.sandbox ? "Sandbox" : "Live marketplace"}
                  <br />
                  Photo: your saved scan above. Full card details remain in the
                  description.
                </p>
                {policies &&
                  [
                    [
                      "merchantLocationKey",
                      "Shipping location",
                      policies.locations,
                      "merchantLocationKey",
                    ],
                    [
                      "paymentPolicyId",
                      "Payment policy",
                      policies.paymentPolicies,
                      "paymentPolicyId",
                    ],
                    [
                      "fulfillmentPolicyId",
                      "Delivery policy",
                      policies.fulfillmentPolicies,
                      "fulfillmentPolicyId",
                    ],
                    [
                      "returnPolicyId",
                      "Returns policy",
                      policies.returnPolicies,
                      "returnPolicyId",
                    ],
                  ].map(([key, label, options, id]) => (
                    <label key={key}>
                      {label}
                      <select
                        required
                        value={settings[key] || ""}
                        onChange={(e) =>
                          setSettings((previous) => ({
                            ...previous,
                            [key]: e.target.value,
                          }))
                        }
                      >
                        <option value="">Choose {label.toLowerCase()}</option>
                        {options.map((option) => (
                          <option key={option[id]} value={option[id]}>
                            {option.name || option[id]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                <div className="capture-actions">
                  <button
                    className="btn btn-primary"
                    disabled={
                      busy ||
                      working ||
                      !policies ||
                      !Object.values(settings).every(Boolean) ||
                      settings.title?.length > 80
                    }
                  >
                    {working
                      ? "Uploading & publishing…"
                      : "Publish this card on eBay"}
                  </button>
                </div>
              </form>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
