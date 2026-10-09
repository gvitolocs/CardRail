import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_WORKSPACE, saveWorkspace } from "./services/inventoryStore.js";
import { request, operation } from "./services/api.js";
import { SCAN_DEFAULTS } from "./core/scanDesk.js";
import { ConnectPhone } from "./ui/ConnectPhone.jsx";
import { Scan } from "./ui/Scan.jsx";
import { Inventory } from "./ui/Inventory.jsx";
import { Pick } from "./ui/Pick.jsx";
import { Platforms } from "./ui/Platforms.jsx";
import { Developer } from "./ui/Developer.jsx";
import { Book } from "./ui/Book.jsx";
import { Stock } from "./ui/Stock.jsx";
import { sortPickLines } from "./engine/pickRun.js";

const NAV = ["overview", "scan", "inventory", "stock", "book", "pick", "platforms", "developer"];
const LABELS = {
  overview: "Dashboard",
  scan: "Scan Pokémon",
  inventory: "Inventory",
  stock: "Live stock",
  book: "Book",
  pick: "Pick run",
  platforms: "Platforms",
  developer: "Developer",
};
export default function App() {
  const [view, setView] = useState(
    location.pathname === "/connect"
      ? "connect"
      : ["#platforms", "#developer", "#stock"].includes(location.hash)
        ? location.hash.slice(1)
        : location.hash.startsWith("#capture=")
          ? "scan"
          : "overview",
  );
  const [phoneMode] = useState(() => {
    try {
      return (
        location.hash.startsWith("#capture=") ||
        sessionStorage.getItem("cardrails_phone") === "1"
      );
    } catch {
      return location.hash.startsWith("#capture=");
    }
  });
  const [workspace, setWorkspace] = useState(EMPTY_WORKSPACE);
  const [query, setQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [intakeOnly, setIntakeOnly] = useState(false);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState("location");
  const [source, setSource] = useState("all");
  const lock = useRef(false);
  const bootstrap = useRef(null);
  const {
    items,
    book,
    links,
    events,
    pickedKeys = [],
    scanQueue = [],
    scanSettings = SCAN_DEFAULTS,
    scanPhone,
    scanPairRequest,
  } = workspace;
  const intake = items.filter((i) => ["scan", "catalog"].includes(i.source));
  const quantity = items.reduce((total, item) => total + item.quantity, 0);
  const accept = useCallback(async (next) => {
    setWorkspace((previous) =>
      next.revision >= previous.revision ? next : previous,
    );
    try {
      await saveWorkspace(next);
    } catch {
      /* The server remains authoritative if local caching fails. */
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!bootstrap.current)
      bootstrap.current = (async () => {
        let next = await request("inventory");
        if (location.hash.startsWith("#capture=")) {
          const pairing = new URLSearchParams(location.hash.slice(1));
          await request("capture", {
            action: "pair",
            id: pairing.get("capture"),
            secret: pairing.get("key"),
            code: pairing.get("code"),
          });
          try {
            sessionStorage.setItem("cardrails_phone", "1");
          } catch {
            /* Phone view still works for this visit. */
          }
          history.replaceState(null, "", location.pathname);
          next = await request("inventory");
        }
        return next;
      })();
    bootstrap.current
      .then((next) => {
        if (!cancelled) {
          setWorkspace(next);
          setReady(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const perform = useCallback(
    async (work) => {
      if (lock.current || !ready) return false;
      lock.current = true;
      setBusy(true);
      setError("");
      try {
        await accept(await work());
        return true;
      } catch (e) {
        setError(e.message);
        return false;
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [ready, accept],
  );
  function openView(id, onlyIntake = false) {
    setView(id);
    setIntakeOnly(onlyIntake);
  }
  async function sell(id, channel, quantity, orderRef, lineId) {
    return perform(() =>
      request("sales", { itemId: id, channel, quantity, orderRef, lineId }),
    );
  }
  useEffect(() => {
    if (!ready) return;
    const refresh = setInterval(async () => {
      if (lock.current || document.hidden) return;
      try {
        const next = await request("inventory");
        if (!lock.current)
          setWorkspace((previous) =>
            next.revision > previous.revision ? next : previous,
          );
      } catch {
        /* Keep the current inventory visible during a temporary network outage. */
      }
    }, 5000);
    return () => clearInterval(refresh);
  }, [ready]);
  const connected = Object.values(links).some(
    (link) => link.status === "connected",
  );
  useEffect(() => {
    if (!ready || !connected) return;
    const timer = setInterval(() => {
      if (!lock.current && !document.hidden) perform(() => request("sync", {}));
    }, 60000);
    return () => clearInterval(timer);
  }, [ready, connected, perform]);
  const arrival = book
    .filter((row) => source === "all" || row.channel === source)
    .map((row) => {
      const item = items.find((i) => i.id === row.itemId);
      return (
        item && {
          key: row.id,
          item,
          orderId: `${row.channel}:${row.orderRef}`,
          orderRef: row.orderRef,
          platform: row.channel,
          quantity: Math.abs(row.delta),
          position: item.location?.verified === false ? null : item.location?.position ?? null,
          location: item.location,
          total: item.price * Math.abs(row.delta),
        }
      );
    })
    .filter(Boolean);
  const scanning = view === "overview" || view === "scan" || view === "connect" || view === "developer";
  const scanner = (
    <Scan
      dashboard={!phoneMode && view === "overview"}
      searchQuery={catalogQuery}
      onSearch={setCatalogQuery}
      queue={scanQueue}
      items={items}
      settings={scanSettings}
      phone={scanPhone}
      phoneMode={phoneMode}
      approval={scanPairRequest}
      onApprove={(id) =>
        perform(() => request("capture", { action: "approve-code", id }))
      }
      links={links}
      onDefaults={async (patch) => {
        if (!ready) return false;
        try {
          await accept(await operation("scan-defaults", { patch }));
          return true;
        } catch (e) {
          setError(e.message);
          return false;
        }
      }}
      onCatalog={(values) =>
        perform(() => operation("stage-catalog", values))
      }
      onUndo={(id) => perform(() => operation("restore-scan", { id }))}
      onChannels={() => openView("platforms")}
      scanned={intake}
      busy={busy || !ready}
      onStage={(values) => perform(() => operation("stage-scan", values))}
      onCommit={(ids, patches, intent) =>
        perform(() => operation("commit-scans", { ids, patches, intent }))
      }
      onRemove={(id) => perform(() => operation("remove-scan", { id }))}
      onOpenInventory={() => openView("inventory", true)}
    />
  );
  if (phoneMode) {
    return (
      <div className="phone-shell">
        <header className="phone-topbar">
          <div className="brand">
            <img src="/favicon.svg" width={28} height={28} alt="" />
            <span className="wordmark">Card Rails</span>
          </div>
          <span className="phone-conn" role="status">
            <span className="live-dot" />
            {scanSettings.paused
              ? "Scanner paused on desktop"
              : "Connected to your desk"}
          </span>
        </header>
        <main className="phone-main">
          {!ready && (
            <p className="workspace-state" role="status">
              {busy ? "Caricamento…" : "Inventario non disponibile"}
            </p>
          )}
          {workspace.syncError && (
            <p className="capture-error" role="alert">
              Stock saved. Channel check: {workspace.syncError}
            </p>
          )}
          {error && (
            <div className="capture-error" role="alert">
              {error}
              {!ready && (
                <button
                  className="btn btn-small"
                  onClick={() => location.reload()}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {scanner}
        </main>
      </div>
    );
  }
  return (
    <div className={scanning ? "scan-shell" : "app-shell"}>
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" width={28} height={28} alt="" />
          <span className="wordmark">Card Rails</span>
        </div>
        <nav className="nav" aria-label="Main navigation">
          {NAV.map((id) => (
            <button
              key={id}
              className={"nav-btn" + (view === id ? " is-active" : "")}
              onClick={() => openView(id)}
            >
              {LABELS[id]}
            </button>
          ))}
        </nav>
        <input
          className="search"
          aria-label="Search the rail"
          placeholder="Search cards, sets, locations…"
          value={view === "overview" || view === "scan" ? catalogQuery : query}
          onChange={(e) => {
            if (view === "overview" || view === "scan") {
              setCatalogQuery(e.target.value);
            } else {
              setQuery(e.target.value);
              openView("inventory");
            }
          }}
        />
        <div className="count">
          <b>{quantity.toLocaleString("en-GB")}</b> cards
        </div>
      </header>
      <main className="main">
        {!ready && (
          <p className="workspace-state" role="status">
            {busy ? "Caricamento…" : "Inventario non disponibile"}
          </p>
        )}
        {workspace.syncError && (
          <p className="capture-error" role="alert">
            Stock saved. Channel check: {workspace.syncError}
          </p>
        )}
        {error && (
          <div className="capture-error" role="alert">
            {error}
            {!ready && (
              <button
                className="btn btn-small"
                onClick={() => location.reload()}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {view === "connect" && <ConnectPhone ready={ready} />}
        {(view === "overview" || view === "scan") && scanner}
        {view === "developer" && <Developer ready={ready} />}
        {view === "inventory" && (
          <Inventory
            items={items}
            query={query}
            links={links}
            busy={busy || !ready}
            intakeOnly={intakeOnly}
            onShowAll={() => setIntakeOnly(false)}
            onAdjust={(id, delta) =>
              perform(() => operation("adjust", { id, delta }))
            }
            onSell={sell}
            onMap={(values) => perform(() => operation("listing", values))}
            onEdit={(id, patch) =>
              perform(() => operation("edit", { id, patch }))
            }
            onPublish={(values) => perform(() => request("listings", values))}
            onSync={() => perform(() => request("sync", {}))}
          />
        )}
        {view === "stock" && <Stock />}
        {view === "book" && <Book rows={book} />}
        {view === "pick" && (
          <Pick
            arrival={arrival}
            lines={sortPickLines(arrival, sort)}
            sort={sort}
            onSort={setSort}
            source={source}
            onSource={setSource}
            pickedKeys={pickedKeys}
            onPick={(key) => perform(() => operation("pick", { key }))}
          />
        )}
        {view === "platforms" && (
          <Platforms
            links={links}
            log={events}
            busy={busy || !ready}
            onWebhook={() =>
              perform(() =>
                request("channels", { action: "enable-cardtrader-webhook" }),
              )
            }
            outbox={workspace.outbox}
            lastSyncAt={workspace.lastSyncAt}
            onConnect={(values) =>
              perform(() =>
                request("channels", { action: "connect", ...values }),
              )
            }
            onDisconnect={(channel) =>
              perform(() =>
                request("channels", { action: "disconnect", channel }),
              )
            }
            onSync={() => perform(() => request("sync", {}))}
          />
        )}
      </main>
    </div>
  );
}
