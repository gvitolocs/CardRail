import { useEffect, useRef, useState } from "react";
import { request } from "../services/api.js";
import { encodeQr, qrPath } from "../core/qr.js";
export function PhoneConnect({
  disabled = false,
  phoneMode = false,
  approval,
  onApprove,
  phone,
  paused = false,
  onPause,
}) {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(() => Date.now());
  const [pairNew, setPairNew] = useState(false);
  const started = useRef(null);
  async function pair() {
    started.current = true;
    setPairNew(true);
    setBusy(true);
    setError("");
    try {
      setSession(await request("capture", { action: "create" }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (disabled || phoneMode || (phone && !pairNew) || started.current) return;
    // Reuse the pending request across React StrictMode's effect replay.
    started.current = request("capture", { action: "create" });
    started.current.then(setSession).catch((e) => setError(e.message));
  }, [disabled, phoneMode, phone, pairNew]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const connected = Boolean(
    (phone && !pairNew) || (session && phone?.captureId === session.id),
  );
  const seconds = Math.min(
    600,
    Math.max(0, Math.ceil(((session?.expiresAt || now) - now) / 1000)),
  );
  const qr = session ? encodeQr(session.url, { ecc: "H" }) : null;
  if (phoneMode)
    return (
      <section className="desk-connect is-connected" aria-label="Phone scanner">
        <div className="desk-connect-main">
          <h2>Connected to your desk</h2>
          <p>Take a photo below. The card appears here and on your desktop.</p>
          <div className="desk-connect-meta">
            <span className="live-dot" />
            {paused ? "Scanner paused on desktop" : "Ready to scan"}
          </div>
        </div>
      </section>
    );
  return (
    <section
      className={"desk-connect" + (connected ? " is-connected" : "")}
      aria-label="Connect your phone"
    >
      <div className="desk-connect-main">
        <h2>{connected ? "Phone connected" : "Connect your phone"}</h2>
        <p>
          {connected ? (
            "Scan on your phone. Each card appears in the queue below."
          ) : (
            <>
              Type the code on <a href="/connect">{location.host}/connect</a>,
              or scan the QR code.
            </>
          )}
        </p>
        {!connected && (
          <div className="desk-pin" aria-label="Pairing code">
            {(session?.code || "····").split("").map((digit, index) => (
              <span key={index}>{digit}</span>
            ))}
          </div>
        )}
        <div className="desk-connect-meta">
          {connected ? (
            <>
              <span className="live-dot" />
              {paused ? "Scanner paused" : "Ready to scan"} ·{" "}
              <button
                className="linkish"
                disabled={disabled}
                onClick={() => onPause(!paused)}
              >
                {paused ? "Resume" : "Pause"}
              </button>{" "}
              ·{" "}
            </>
          ) : (
            <>
              {session
                ? seconds
                  ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
                  : "Code expired"
                : "Preparing pairing code…"}{" "}
              ·{" "}
            </>
          )}
          <button
            className="linkish"
            disabled={disabled || busy}
            onClick={pair}
          >
            New code
          </button>
        </div>
        {error && (
          <p className="scan-alert" role="alert">
            {error}{" "}
            <button className="linkish" onClick={pair}>
              Retry
            </button>
          </p>
        )}
      </div>
      {approval?.expiresAt > now && (
        <div className="desk-phone-approval" role="status">
          <b>Phone request · {approval.code}</b>
          <p>Allow this phone to share your inventory and scan queue?</p>
          <button
            className="btn btn-primary"
            disabled={disabled || approval.status === "approved"}
            onClick={() => onApprove(approval.id)}
          >
            {approval.status === "approved" ? "Connecting…" : "Allow phone"}
          </button>
        </div>
      )}
      {!connected && (
        <figure className="desk-qr">
          {qr ? (
            <>
              <svg
                viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
                role="img"
                aria-label="QR code to connect your phone"
                shapeRendering="crispEdges"
              >
                <rect width="100%" height="100%" fill="white" />
                <path d={qrPath(qr)} fill="black" />
                <rect x={(qr.size + 8) / 2 - 5} y={(qr.size + 8) / 2 - 5} width={10} height={10} rx={2} fill="white" />
                <image href="/favicon.svg" x={(qr.size + 8) / 2 - 4} y={(qr.size + 8) / 2 - 4} width={8} height={8} />
              </svg>
              <a href={session.url}>Open on phone</a>
            </>
          ) : (
            <div className="qr-skeleton" />
          )}
          <figcaption>Scan with the phone camera.</figcaption>
        </figure>
      )}
    </section>
  );
}
