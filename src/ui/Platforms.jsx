import { useEffect, useState } from "react";
import { platformLabel } from "../core/canonical.js";
import { request } from "../services/api.js";
export function Platforms({
  links,
  log,
  outbox,
  onConnect,
  onDisconnect,
  onSync,
  onWebhook,
  busy,
  lastSyncAt,
}) {
  const [channel, setChannel] = useState("cardtrader"),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [config, setConfig] = useState({}),
    [app, setApp] = useState({
      clientId: "",
      clientSecret: "",
      redirectUri: "",
    }),
    [sandbox, setSandbox] = useState(false);
  useEffect(() => {
    request("channels")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  async function run(work) {
    setWorking(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function connect(event) {
    event.preventDefault();
    await run(async () => {
      if (await onConnect({ channel, token, sandbox })) {
        setToken("");
      }
    });
  }
  async function oauth() {
    await run(async () => {
      const result = await request("oauth", { action: "begin" });
      location.assign(result.url);
    });
  }
  return (
    <section>
      <p className="kicker">Connected channels</p>
      <h1 className="page-title">Your stock. Everywhere you sell.</h1>
      <p className="page-sub">
        Connect your seller accounts. Card Rails saves each sale first, then
        delivers stock changes to your connected listings.
      </p>
      <div className="channel-cards">
        {["pokoin", "cardmarket", "cardtrader", "ebay"].map((id) => {
          const connected = links[id]?.status === "connected";
          return (
            <article className="channel-card" key={id}>
              <div className="channel-card-head">
                <span className={"src src-" + id}>{platformLabel(id)}</span>
                <span
                  className={
                    "connection-status" + (connected ? " connected" : "")
                  }
                >
                  {connected ? "Connected" : "Not connected"}
                </span>
              </div>
              <h2>{platformLabel(id)}</h2>
              <p>
                {connected
                  ? links[id].name || `Seller ${links[id].accountRef}`
                  : id === "pokoin"
                    ? "Public catalog and recognition available. Seller sync needs a Card Rails grant from Pokoin."
                    : id === "cardmarket"
                      ? "Available when your connected Pokoin account verifies its Cardmarket link."
                      : id === "cardtrader"
                        ? "Connect an API token. Quantity changes use increments and decrements."
                        : "Authorize your seller account to publish with your saved card photos."}
              </p>
              {connected ? (
                <div className="row-actions">
                  <button
                    className="btn btn-small"
                    disabled={busy || working}
                    onClick={() => onDisconnect(id)}
                  >
                    Disconnect
                  </button>
                  {id === "cardtrader" && (
                    <button
                      className="btn btn-small"
                      disabled={
                        busy || working || links.cardtrader.webhookEnabled
                      }
                      onClick={onWebhook}
                    >
                      {links.cardtrader.webhookEnabled
                        ? "Live sales enabled"
                        : "Enable live sale webhook"}
                    </button>
                  )}
                </div>
              ) : id === "cardtrader" || id === "ebay" ? (
                <button
                  className="btn"
                  onClick={() => {
                    setChannel(id);
                    setToken("");
                    setError("");
                  }}
                >
                  Set up {platformLabel(id)}
                </button>
              ) : id === "pokoin" && config.pokoinConnectorConfigured ? (
                <button className="btn" onClick={() => setChannel(id)}>
                  Connect grant
                </button>
              ) : (
                <span className="channel-note">
                  {id === "pokoin"
                    ? "Seller connector not deployed"
                    : "Waiting for verified Pokoin link"}
                </span>
              )}
            </article>
          );
        })}
      </div>
      <div className="connection-panel">
        <h2>Connect {platformLabel(channel)}</h2>
        {channel === "ebay" && (
          <>
            <button
              className="btn btn-primary"
              disabled={busy || working}
              onClick={oauth}
            >
              Sign in with eBay
            </button>
            {!config.ebayOAuthConfigured && (
              <details className="app-config">
                <summary>Set up your eBay developer application</summary>
                <p>
                  Use the application’s Client ID, secret and RuName. Register{" "}
                  <code>https://cardrails.vercel.app/api/v1/oauth</code> as the
                  accepted redirect URL.
                </p>
                <form
                  className="capture-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      await request("oauth", {
                        action: "configure",
                        ...app,
                        sandbox,
                      });
                      setApp({
                        clientId: "",
                        clientSecret: "",
                        redirectUri: "",
                      });
                      setConfig((previous) => ({
                        ...previous,
                        ebayOAuthConfigured: true,
                      }));
                    });
                  }}
                >
                  {["clientId", "clientSecret", "redirectUri"].map((key) => (
                    <label key={key}>
                      {
                        {
                          clientId: "Client ID",
                          clientSecret: "Client secret",
                          redirectUri: "RuName",
                        }[key]
                      }
                      <input
                        type={key === "clientSecret" ? "password" : "text"}
                        autoComplete="off"
                        required
                        value={app[key]}
                        onChange={(e) =>
                          setApp((previous) => ({
                            ...previous,
                            [key]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      checked={sandbox}
                      onChange={(e) => setSandbox(e.target.checked)}
                    />{" "}
                    Sandbox
                  </label>
                  <button className="btn" disabled={working}>
                    Save application
                  </button>
                </form>
              </details>
            )}
          </>
        )}
        <form className="capture-form" onSubmit={connect}>
          <label className="wide">
            {channel === "ebay"
              ? "Or connect a seller access token"
              : channel === "cardtrader"
                ? "CardTrader API token"
                : "Card Rails scoped seller grant"}
            <input
              aria-label={`${platformLabel(channel)} API token`}
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          {channel === "ebay" && (
            <label>
              <input
                type="checkbox"
                checked={sandbox}
                onChange={(e) => setSandbox(e.target.checked)}
              />{" "}
              eBay Sandbox
            </label>
          )}
          <div className="capture-actions">
            <button className="btn" disabled={busy || working || !token.trim()}>
              Verify & connect
            </button>
            <span>
              Encrypted before storage. Connection requires a successful seller
              API check.
            </span>
          </div>
        </form>
      </div>
      {error && (
        <p className="capture-error" role="alert">
          {error}
        </p>
      )}
      <div className="sync-toolbar">
        <div>
          <h2>Stock delivery</h2>
          <p>
            {lastSyncAt
              ? `Last check ${new Date(lastSyncAt).toLocaleString()}`
              : "No channel check yet"}{" "}
            · {outbox.length} pending updates
          </p>
        </div>
        <button
          className="btn btn-primary"
          disabled={
            busy ||
            working ||
            !Object.values(links).some((link) => link.status === "connected")
          }
          onClick={onSync}
        >
          Check sales & sync stock
        </button>
      </div>
      <div className="channel-order">
        <b>Delivery order</b>
        <span>1 · Save Card Rails</span>
        <span>2 · Pokoin</span>
        <span>3 · Linked Cardmarket</span>
        <span>4 · Other connected channels</span>
      </div>
      {outbox.length > 0 && (
        <ul className="sync-log">
          {outbox.map((intent) => (
            <li key={intent.idempotencyKey}>
              <b>{platformLabel(intent.platform)}</b> · {intent.targetQuantity}{" "}
              desired · {intent.status}
              {intent.reason && <p>{intent.reason}</p>}
            </li>
          ))}
        </ul>
      )}
      <details className="inventory-editor">
        <summary>Recent stock events</summary>
        <ul className="sync-log">
          {!log.length && <li>No stock events yet.</li>}
          {log.slice(0, 30).map((event) => (
            <li key={event.id}>
              <b>{event.cause}</b>
              {event.name ? ` · ${event.name}` : ""}
              {event.delta
                ? ` · ${event.delta > 0 ? "+" : ""}${event.delta}`
                : ""}
              {event.oversell ? ` · oversold ${event.oversell}` : ""}
              <small>{new Date(event.at).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
