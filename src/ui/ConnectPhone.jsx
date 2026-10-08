import { useEffect, useState } from "react";
import { request } from "../services/api.js";
export function ConnectPhone({ ready }) {
  const [code, setCode] = useState(""),
    [pairing, setPairing] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function connect(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setPairing(await request("capture", { action: "request-code", code }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!pairing) return;
    let cancelled = false,
      running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const result = await request("capture", {
          action: "poll-code",
          id: pairing.id,
          secret: pairing.secret,
        });
        if (!cancelled && result.paired) {
          try {
            sessionStorage.setItem("cardrails_phone", "1");
          } catch {}
          location.assign("/");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setPairing(null);
        }
      } finally {
        running = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pairing]);
  return (
    <section className="desk-connect code-connect">
      <div className="desk-connect-main">
        <p className="kicker">Card Rails · Phone scanner</p>
        <h1>Connect to your desk</h1>
        <p>Enter the code shown on your desktop.</p>
        <form onSubmit={connect}>
          <label>
            Pairing code
            <input
              aria-label="Desktop pairing code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4}"
              maxLength={4}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={!ready || busy || code.length !== 4 || !!pairing}
          >
            {busy
              ? "Connecting…"
              : pairing
                ? "Waiting for desktop approval…"
                : "Connect phone"}
          </button>
        </form>
        {pairing && (
          <p role="status">
            Confirm this phone on your desktop to share its inventory and scan
            queue.
          </p>
        )}
        {error && (
          <p className="scan-alert" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
