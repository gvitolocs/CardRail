import { useEffect, useMemo, useRef, useState } from "react";
import { cloud, cloudToken, loadCloudInventory, signIn, signOut } from "../services/cloud.js";

const eur = (n) => (n ?? 0).toLocaleString("en-GB", { style: "currency", currency: "EUR" });
const PAGE = 200;

function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

function slot(copy) {
  const l = copy.location;
  if (!l) return "";
  if (l.position == null) return l.box;
  const range = l.end && l.end !== l.position ? `${l.position}–${l.end}` : l.position;
  return `${l.box} · row ${l.row} · ${range}`;
}

/** Account shared with the apps: CardTrader import, stock CSV locations, live inventory. */
export function Stock() {
  const [signedIn, setSignedIn] = useState(() => Boolean(cloudToken.get()));
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!signedIn) return;
    cloud("/v1/auth/me")
      .then((data) => setMe(data.account ?? data))
      .catch((e) => {
        if (e.status === 401) setSignedIn(false);
        else setError(e.message);
      });
  }, [signedIn]);
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;
  return (
    <section>
      <p className="kicker">Live stock · {me?.email ?? "…"}</p>
      <h1 className="page-title">Your stock, kept in sync.</h1>
      <p className="page-sub">
        The same account as the iPhone and Android apps. Connect CardTrader: your products are
        imported in the background and stay aligned. Locations come from the scanner or from a
        Power Tools CSV.
      </p>
      {error && <p className="capture-error" role="alert">{error}</p>}
      <Live
        onSignOut={async () => {
          await signOut();
          setSignedIn(false);
        }}
      />
    </section>
  );
}

function SignIn({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [create, setCreate] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      await signIn(email.trim(), password, create);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section>
      <p className="kicker">Live stock</p>
      <h1 className="page-title">Sign in to Card Rails</h1>
      <p className="page-sub">Use the same account as the iPhone and Android apps.</p>
      <div className="connection-panel">
        <form className="capture-form" onSubmit={submit}>
          <label className="wide">
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="wide">
            Password
            <input
              type="password"
              autoComplete={create ? "new-password" : "current-password"}
              required
              minLength={create ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="capture-actions">
            <button className="btn btn-primary" disabled={working}>
              {create ? "Create account" : "Sign in"}
            </button>
            <button type="button" className="btn" onClick={() => setCreate(!create)}>
              {create ? "I already have an account" : "Create an account"}
            </button>
          </div>
        </form>
        {error && <p className="capture-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

function Live({ onSignOut }) {
  const [status, setStatus] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [error, setError] = useState("");
  const lastFinished = useRef(null);

  async function refreshInventory() {
    try {
      setInventory(await loadCloudInventory());
    } catch (e) {
      setError(e.message);
    }
  }
  async function refreshStatus() {
    const next = await cloud("/v1/integrations/cardtrader");
    setStatus(next);
    const finished = next.sync?.finishedAt ?? null;
    if (finished && finished !== lastFinished.current) {
      lastFinished.current = finished;
      refreshInventory();
    }
    return next;
  }
  useEffect(() => {
    refreshStatus().catch((e) => setError(e.message));
    refreshInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const syncing = ["queued", "running"].includes(status?.sync?.status);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => refreshStatus().catch(() => {}), 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  return (
    <>
      {error && <p className="capture-error" role="alert">{error}</p>}
      <CardTraderPanel status={status} onStatus={setStatus} syncing={syncing} onError={setError} />
      <LocationsPanel onApplied={refreshInventory} onError={setError} />
      <CloudInventory inventory={inventory} onReload={refreshInventory} />
      <p className="page-sub">
        <button className="btn btn-small" onClick={onSignOut}>Sign out</button>
      </p>
    </>
  );
}

function CardTraderPanel({ status, onStatus, syncing, onError }) {
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  async function run(work) {
    setWorking(true);
    onError("");
    try {
      onStatus(await work());
    } catch (e) {
      onError(e.message);
    } finally {
      setWorking(false);
    }
  }
  if (!status) return <div className="connection-panel">Loading…</div>;
  const stats = status.sync?.stats ?? {};
  return (
    <div className="connection-panel">
      <h2>CardTrader</h2>
      {status.connected ? (
        <>
          <p>
            <b>{status.app.name}</b>
            {status.app.oneDayReady && <span className="pill is-on" style={{ marginLeft: 8 }}>1-Day Ready</span>}
          </p>
          <div className="stats">
            <div className="stat"><div className="num">{(stats.products ?? 0).toLocaleString("en-GB")}</div><div className="lbl">products</div></div>
            <div className="stat"><div className="num">{(status.copies ?? 0).toLocaleString("en-GB")}</div><div className="lbl">copies in stock</div></div>
            <div className="stat"><div className="num">{stats.timings ? `${(stats.timings.totalMs / 1000).toFixed(1)} s` : "—"}</div><div className="lbl">last import</div></div>
            <div className="stat"><div className="num">{syncing ? "…" : when(status.sync.finishedAt)}</div><div className="lbl">{syncing ? "importing" : "last updated"}</div></div>
          </div>
          {stats.products != null && !syncing && (
            <p className="channel-note">
              New {stats.created} · updated {stats.updated} · sold/removed {stats.removed} · unchanged {stats.unchanged}
              {stats.notInCatalog ? ` · ${stats.notInCatalog} outside our catalogs (kept with CardTrader details)` : ""}
              {stats.skipped?.language ? ` · ${stats.skipped.language} in unsupported languages` : ""}
            </p>
          )}
          {status.sync.status === "failed" && <p className="capture-error" role="alert">{status.sync.error}</p>}
          <div className="capture-actions">
            <button className="btn btn-primary" disabled={working || syncing} onClick={() => run(() => cloud("/v1/integrations/cardtrader/sync", { method: "POST", body: {} }))}>
              {syncing ? "Importing…" : "Sync now"}
            </button>
            <button className="btn" disabled={working} onClick={() => run(() => cloud("/v1/integrations/cardtrader", { method: "DELETE" }))}>
              Disconnect
            </button>
            <span>Syncs by itself every 15 minutes.</span>
          </div>
        </>
      ) : (
        <form
          className="capture-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const next = await cloud("/v1/integrations/cardtrader", { method: "PUT", body: { token: token.trim() } });
              setToken("");
              return next;
            });
          }}
        >
          <label className="wide">
            CardTrader API token (Settings → API)
            <input type="password" autoComplete="off" required value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <div className="capture-actions">
            <button className="btn btn-primary" disabled={working || !token.trim()}>
              {working ? "Checking…" : "Connect and import"}
            </button>
            <span>Checked with CardTrader and stored encrypted. The import starts right away in the background.</span>
          </div>
        </form>
      )}
    </div>
  );
}

const PARSE_LABELS = {
  as_is: "Whole text is the box",
  trailing_stack: "Last number is the stack (e.g. “FUOCOBOMBA 006 - 16”)",
  structured: "Already box·stack(·position)",
};

function LocationsPanel({ onApplied, onError }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [options, setOptions] = useState({ locationParse: "auto", stackSize: "", numberedInStack: false });
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);
  async function send(apply, text = csv, opts = options) {
    setWorking(true);
    onError("");
    try {
      const result = await cloud("/v1/inventory/locations/csv", {
        method: "POST",
        body: {
          csv: text,
          apply,
          locationParse: opts.locationParse,
          stackSize: Number(opts.stackSize) > 0 ? Number(opts.stackSize) : undefined,
          numberedInStack: opts.numberedInStack,
        },
      });
      setPreview(result);
      if (apply) onApplied();
    } catch (e) {
      onError(e.message);
    } finally {
      setWorking(false);
    }
  }
  function update(patch) {
    const next = { ...options, ...patch };
    setOptions(next);
    if (csv) send(false, csv, next);
  }
  return (
    <div className="connection-panel">
      <h2>Locations from a stock CSV</h2>
      <p className="channel-note">
        Export your stock from Power Tools (or Cardmarket/CardTrader) with the location column: each row is matched
        to its copy by name, number, condition, language, reverse and 1st edition. Preview first, then apply.
      </p>
      <div className="capture-form">
        <label className="wide">
          CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              setCsv(text);
              setFileName(file.name);
              send(false, text);
            }}
          />
        </label>
        <label>
          Location format
          <select value={options.locationParse} onChange={(e) => update({ locationParse: e.target.value })}>
            <option value="auto">Automatic</option>
            {Object.entries(PARSE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          Cards per stack
          <input
            type="number"
            min="1"
            placeholder={preview ? String(preview.suggestedStackSize) : ""}
            value={options.stackSize}
            onChange={(e) => update({ stackSize: e.target.value })}
          />
        </label>
        <label>
          <input type="checkbox" checked={options.numberedInStack} onChange={(e) => update({ numberedInStack: e.target.checked })} />{" "}
          Number cards inside the stack (file order)
        </label>
      </div>
      {preview && (
        <>
          <div className="stats">
            <div className="stat"><div className="num">{preview.matched.toLocaleString("en-GB")}</div><div className="lbl">copies matched</div></div>
            <div className="stat"><div className="num">{preview.csvOnly.toLocaleString("en-GB")}</div><div className="lbl">CSV rows without a copy</div></div>
            <div className="stat"><div className="num">{preview.inventoryOnly.toLocaleString("en-GB")}</div><div className="lbl">copies not in the CSV</div></div>
            <div className="stat"><div className="num">{preview.timings.parseMs + preview.timings.matchMs + preview.timings.loadMs + preview.timings.writeMs} ms</div><div className="lbl">server time</div></div>
          </div>
          <p className="channel-note">
            {fileName} · {preview.format} · {preview.rows.toLocaleString("en-GB")} rows · detected format:{" "}
            {PARSE_LABELS[preview.locationDetection.locationParse]} · examples: {preview.locationDetection.examples.join(", ") || "—"}
          </p>
          {preview.overflows.length > 0 && (
            <p className="capture-error">
              {preview.overflows.length} stacks exceed their capacity (e.g. {preview.overflows[0].label}: {preview.overflows[0].copies} cards).
            </p>
          )}
          <div className="capture-actions">
            <button className="btn btn-primary" disabled={working || preview.matched === 0} onClick={() => send(true)}>
              {preview.applied ? "Locations applied ✓" : `Apply to ${preview.matched.toLocaleString("en-GB")} copies`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CloudInventory({ inventory, onReload }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const filtered = useMemo(() => {
    if (!inventory) return [];
    const q = query.trim().toLowerCase();
    if (!q) return inventory.copies;
    return inventory.copies.filter((c) => `${c.name} ${c.setName} ${c.number} ${slot(c)}`.toLowerCase().includes(q));
  }, [inventory, query]);
  if (!inventory) return <div className="connection-panel">Loading inventory…</div>;
  const copies = inventory.copies.reduce((n, c) => n + c.quantity, 0);
  return (
    <div className="connection-panel">
      <h2>
        Inventory · {copies.toLocaleString("en-GB")} copies in {inventory.copies.length.toLocaleString("en-GB")} rows
      </h2>
      <div className="capture-actions">
        <input className="search" placeholder="Search card, set, location…" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} />
        <button className="btn btn-small" onClick={onReload}>Reload</button>
      </div>
      <div className="table-scroll">
        <table className="stock-table">
          <thead>
            <tr>
              <th>Card</th><th>Language</th><th>Cond.</th><th>Finish</th><th>Qty</th><th>Price</th><th>Location</th><th>Source</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, shown).map((c) => (
              <tr key={c.seq}>
                <td>
                  <b>{c.name || "—"}</b>
                  <div className="channel-note">{[c.setName, c.number].filter(Boolean).join(" · ")}</div>
                </td>
                <td>{c.language}</td>
                <td>{c.condition}</td>
                <td>{c.printing}</td>
                <td>{c.quantity}</td>
                <td>{eur(c.price)}</td>
                <td>{slot(c) || <span className="channel-note">to place</span>}</td>
                <td>{c.cardtrader ? "CardTrader" : c.imported ? "Import" : "Scanner"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > shown && (
        <button className="btn" onClick={() => setShown(shown + PAGE * 5)}>
          Show more ({(filtered.length - shown).toLocaleString("en-GB")})
        </button>
      )}
    </div>
  );
}
