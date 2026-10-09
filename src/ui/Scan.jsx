import { useEffect, useEffectEvent, useRef, useState } from "react";
import { searchPokoinCatalog } from "../connectors/pokoinPublic.js";
import { displayPhoto } from "../core/canonical.js";
import {
  SCAN_DEFAULTS,
  SCAN_LANGUAGES,
  SCAN_CONDITIONS,
  SCAN_FINISHES,
  SCAN_GAMES,
  allocateScanLocations,
  scanSlotText,
} from "../core/scanDesk.js";
import { storeScanPhoto } from "../services/photoStore.js";
import { recognizePublicPhoto } from "../services/recognition.js";
import { PhoneConnect } from "./PhoneConnect.jsx";
import "./pokemon-desk.css";
const FLAGS = { firstEdition: "1st Ed.", signed: "Signed", altered: "Altered" };
function Toggle({ active, onClick, children, disabled, label }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!!active}
      className={active ? "on" : ""}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Options({ label, value, options, onChange, disabled }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((x) => (
        <option key={x} value={x}>
          {SCAN_GAMES[x] || x}
        </option>
      ))}
    </select>
  );
}
function catalogCard(card) {
  const art = card.imageUrl || card.image_url || "";
  return {
    name: card.name,
    setName: card.set_name || card.set || "",
    number: card.card_number || card.number || "",
    publicId: String(card.card_id || card.id || ""),
    cardtraderBlueprintId: String(
      card.ct_id || card.cardtraderBlueprintId || "",
    ),
    art: art.startsWith("/") ? "https://pokoin.com" + art : art,
  };
}
export function Scan({
  searchQuery = "",
  onSearch,
  queue = [],
  items = [],
  settings = SCAN_DEFAULTS,
  phone,
  phoneMode,
  approval,
  onApprove,
  links = {},
  busy,
  onStage,
  onCatalog,
  onCommit,
  onRemove,
  onUndo,
  onDefaults,
  onChannels,
  onOpenInventory,
}) {
  const [defaultEdits, setDefaults] = useState({});
  const defaults = { ...SCAN_DEFAULTS, ...settings, ...defaultEdits };
  const [patches, setPatches] = useState({}),
    [working, setWorking] = useState(false),
    [pending, setPending] = useState(null),
    [camera, setCamera] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [intent, setIntent] = useState("sale"),
    [target, setTarget] = useState("rail"),
    [help, setHelp] = useState(false),
    [stackOpen, setStackOpen] = useState(false),
    [selected, setSelected] = useState(null),
    [undo, setUndo] = useState(null);
  const search = searchQuery,
    setSearch = onSearch;
  const [results, setResults] = useState([]),
    [searching, setSearching] = useState(false),
    [draft, setDraft] = useState(null),
    [draftQty, setDraftQty] = useState(1),
    [draftPrice, setDraftPrice] = useState(0);
  const input = useRef(null),
    video = useRef(null),
    stream = useRef(null),
    searchInput = useRef(null);
  const disabled = busy || working;
  useEffect(
    () => () => stream.current?.getTracks().forEach((track) => track.stop()),
    [],
  );
  useEffect(() => {
    if (camera && video.current) video.current.srcObject = stream.current;
  }, [camera]);
  const paused = defaults.paused;
  useEffect(() => {
    if (!phoneMode || paused || busy || document.hidden) return;
    if (camera || stream.current) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    startCamera();
  }, [phoneMode, paused, busy, camera]);
  useEffect(() => {
    if (phoneMode && paused) stopCamera();
  }, [phoneMode, paused]);
  useEffect(() => {
    if (!phoneMode) return;
    const onVisibility = () => {
      if (document.hidden) stopCamera();
      else if (!paused && !busy) startCamera();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [phoneMode, paused, busy]);
  useEffect(() => {
    if (search.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const cards = await searchPokoinCatalog(search, {
          game: defaults.game,
          signal: controller.signal,
        });
        setResults(cards.map(catalogCard));
        setError("");
      } catch (e) {
        if (e.name !== "AbortError") setError(e.message);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, defaults.game]);
  function patch(id, values) {
    setPatches((previous) => ({
      ...previous,
      [id]: { ...previous[id], ...values },
    }));
    setNotice("");
  }
  async function changeDefaults(values) {
    setDefaults((previous) => ({ ...previous, ...values }));
    setPatches((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([id, p]) => [
          id,
          Object.fromEntries(
            Object.entries(p).filter(([key]) => !(key in values)),
          ),
        ]),
      ),
    );
    if (await onDefaults(values)) {
      setDefaults((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([key]) => !(key in values)),
        ),
      );
    } else setError("Batch defaults were not saved. Please try again.");
  }
  function stopCamera() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCamera(false);
  }
  async function captureFile(file) {
    setWorking(true);
    setError("");
    setNotice("");
    setPending(null);
    try {
      const photo = await storeScanPhoto(file);
      setPending(photo);
      let hits = [];
      try {
        const result = await recognizePublicPhoto(photo, {
          game: defaults.game,
          language: defaults.language,
        });
        if (result.multipleCards)
          throw new Error("Photograph one card at a time.");
        hits = result.hits;
      } catch (e) {
        setError(e.message);
      }
      const card = hits[0];
      const success = await onStage({
        item: {
          identity: {
            game: defaults.game,
            name: card?.name || "Carta da identificare",
            setName: card?.setName || "—",
            number: card?.number || "—",
            publicId: card?.publicId || "",
            cardtraderBlueprintId: card?.cardtraderBlueprintId || "",
          },
          art: card?.art || "",
          ...defaults,
          quantity: 1,
          price: 0,
          scanPhoto: photo,
        },
        defaults,
        candidates: hits,
        confidence: card?.score || 0,
        needsIdentification: !card,
      });
      if (success) {
        setPending(null);
        setNotice(
          card
            ? `${card.name} added to the queue.`
            : "Photo saved. Click Identify to choose the card.",
        );
      } else setError("Photo was not saved. Please scan again.");
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function capture(event) {
    const file = event.target.files?.[0];
    if (file) await captureFile(file);
    event.target.value = "";
  }
  async function startCamera() {
    setError("");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } },
        audio: false,
      });
      setCamera(true);
    } catch {
      setError(
        "Camera unavailable. Use Upload photo to take or select a photo.",
      );
    }
  }
  async function shutter() {
    if (!video.current?.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.current.videoWidth;
    canvas.height = video.current.videoHeight;
    canvas.getContext("2d").drawImage(video.current, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    stopCamera();
    if (blob)
      await captureFile(new File([blob], "camera.jpg", { type: "image/jpeg" }));
  }
  async function addCatalog(event) {
    event.preventDefault();
    if (!draft) return;
    const success = await onCatalog({
      item: {
        identity: { ...draft, game: defaults.game },
        art: draft.art,
        ...defaults,
        quantity: Number(draftQty),
        price: Number(draftPrice),
      },
      defaults,
    });
    if (success) {
      setNotice(`${draft.name} added to the queue.`);
      setDraft(null);
      setSearch("");
      setResults([]);
      searchInput.current?.focus();
    }
  }
  const editedRows = queue.map((row) => ({
    ...row,
    ...patches[row.id],
    identity: { ...row.identity, ...patches[row.id]?.identity },
  }));
  const rows = allocateScanLocations(items, editedRows);
  const active = rows.find((row) => row.id === selected);
  const count = rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const unidentified = rows.filter(
    (row) =>
      row.needsIdentification &&
      !["name", "setName", "number"].every(
        (key) =>
          row.identity[key] &&
          !["—", "Carta da identificare"].includes(row.identity[key]),
      ),
  ).length;
  const invalid = rows.some(
    (row) =>
      !row.location ||
      !Number.isSafeInteger(row.quantity) ||
      row.quantity < 1 ||
      !Number.isFinite(row.price) ||
      row.price < 0,
  );
  const channelBlocked = intent === "sale" && target !== "rail";
  async function commit() {
    if (disabled || !rows.length || unidentified || invalid || channelBlocked)
      return;
    setError("");
    if (
      await onCommit(
        rows.map((row) => row.id),
        patches,
        intent,
      )
    ) {
      setPatches({});
      setSelected(null);
      setUndo(null);
      setNotice(
        intent === "collection"
          ? "Cards added to your collection."
          : "Cards added to inventory. Continue scanning or open Inventory to list them.",
      );
    }
  }

  const keyboardCommand = useEffectEvent((e) => {
    if (e.key === "Escape") {
      setHelp(false);
      setSelected(null);
      setDraft(null);
      stopCamera();
      return;
    }
    if (e.target.closest("input,select,textarea")) return;
    if (e.key === "?") {
      e.preventDefault();
      setHelp(true);
    }
    if (e.key === "/") {
      e.preventDefault();
      searchInput.current?.focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });
  useEffect(() => {
    const keys = (e) => keyboardCommand(e);
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);
  async function remove(row) {
    if (await onRemove(row.id)) {
      setUndo(row);
      setSelected(null);
      setNotice(`${row.identity.name} removed.`);
    }
  }
  const title =
    intent === "collection"
      ? `Add ${count} cards to collection`
      : target === "rail"
        ? `Add ${count} cards to inventory`
        : `Add ${count} cards to ${target === "pokoin" ? "Pokoin" : "CardTrader"}`;
  const correction = active && (
    <section className="queue-correction">
      <h3>Review card</h3>
      <div className="queue-candidates">
        {active.scanCandidates?.map((card, index) => (
          <button
            className="btn"
            key={index}
            onClick={() =>
              patch(active.id, {
                identity: { ...active.identity, ...card },
                needsIdentification: false,
              })
            }
          >
            {card.name} · {card.setName} · {card.number}
          </button>
        ))}
      </div>
      <form
        className="capture-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSelected(null);
        }}
      >
        {[
          ["name", "Card name"],
          ["setName", "Set"],
          ["number", "Number"],
        ].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              required
              value={active.identity[key]}
              onChange={(e) =>
                patch(active.id, {
                  identity: {
                    ...active.identity,
                    [key]: e.target.value,
                    publicId: "",
                    cardtraderBlueprintId: "",
                  },
                })
              }
            />
          </label>
        ))}
        <button className="btn" type="submit">
          Confirm details
        </button>
      </form>
    </section>
  );
  const noticeBar = notice && (
    <p className="desk-notice" role="status">
      {notice}{" "}
      {undo && (
        <button
          className="linkish"
          disabled={disabled}
          onClick={async () => {
            if (await onUndo(undo.id)) {
              setUndo(null);
              setNotice("Card restored.");
            }
          }}
        >
          Undo
        </button>
      )}
    </p>
  );
  if (phoneMode) {
    const phoneList = [];
    if (working && pending) phoneList.push({ pending: true });
    for (const row of [...rows].reverse()) {
      if (phoneList.length >= 10) break;
      phoneList.push({ row });
    }
    return (
      <section className="pokemon-desk is-phone">
        <header className="phone-head">
          <h1 className="phone-title">Connected to your desk</h1>
          <p className="phone-sub" role="status">
            <span className="live-dot" />
            {paused
              ? "Scanner paused on desktop"
              : working
                ? "Recognizing…"
                : count > 0
                  ? `${count} card${count === 1 ? "" : "s"} in your desk queue`
                  : "Point at a card and tap the shutter"}
          </p>
        </header>
        {error && (
          <p className="scan-alert" role="alert">
            {error}
            <button className="linkish" onClick={() => setError("")}>
              Dismiss
            </button>
          </p>
        )}
        {paused ? (
          <p className="phone-paused" role="status">
            Scanner paused on desktop
          </p>
        ) : (
          <>
            <div className="phone-camera">
              {camera ? (
                <>
                  <video ref={video} autoPlay muted playsInline />
                  <div className="desk-camera-frame" />
                </>
              ) : (
                <div className="phone-camera-idle">
                  <p>Camera preview is off.</p>
                  {navigator.mediaDevices?.getUserMedia && (
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled}
                      onClick={startCamera}
                    >
                      Start camera
                    </button>
                  )}
                </div>
              )}
            </div>
            {camera ? (
              <div className="phone-shutter-bar">
                <button
                  type="button"
                  className="phone-shutter"
                  aria-label="Take photo"
                  disabled={disabled}
                  onClick={shutter}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary phone-take-photo"
                disabled={disabled}
                onClick={() => input.current?.click()}
              >
                Take photo
              </button>
            )}
          </>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="capture-input"
          aria-label="Scan photo"
          onChange={capture}
        />
        {phoneList.length > 0 && (
          <ul className="phone-list" aria-label="Scanned cards">
            {phoneList.map((entry) => {
              if (entry.pending)
                return (
                  <li key="pending">
                    <div className="phone-row">
                      <img src={pending.dataUrl} alt="Scanned photo" />
                      <span className="phone-row-main">
                        <b>Recognizing card…</b>
                        <small>Just captured</small>
                      </span>
                      <span className="phone-state">Identifying</span>
                    </div>
                  </li>
                );
              const row = entry.row;
              const review =
                row.needsIdentification && !patches[row.id]?.identity;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="phone-row"
                    onClick={
                      review
                        ? () => setSelected(selected === row.id ? null : row.id)
                        : undefined
                    }
                  >
                    <img src={displayPhoto(row)} alt={row.identity.name} />
                    <span className="phone-row-main">
                      <b>{row.identity.name}</b>
                      <small>
                        {row.identity.setName} · {row.identity.number}
                      </small>
                    </span>
                    <span className={"phone-state" + (review ? " review" : "")}>
                      {review ? "Needs review" : "Ready"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {correction}
        {noticeBar}
      </section>
    );
  }
  return (
    <section className="pokemon-desk">
      <header className="pokemon-head">
        <div>
          <p className="kicker">Seller · Scan</p>
          <h1>Scan cards</h1>
        </div>
        <div className="desk-status" role="status">
          <i />
          {working
            ? "Recognizing…"
            : defaults.paused
              ? "Paused"
              : phone
                ? "Phone connected"
                : "Waiting for phone…"}
          {count > 0 ? ` · ${count} in queue` : ""}
        </div>
        <div className="desk-head-actions">
          <button
            className="desk-help"
            aria-label="Keyboard shortcuts"
            onClick={() => setHelp(true)}
          >
            ?
          </button>
          <button className="btn ghost" onClick={onOpenInventory}>
            My Card Rails
          </button>
        </div>
      </header>
      <PhoneConnect
        disabled={busy}
        phone={phone}
        phoneMode={phoneMode}
        approval={approval}
        onApprove={onApprove}
        paused={defaults.paused}
        onPause={(paused) => changeDefaults({ paused })}
      />
      <section className="desk-intent">
        <span>What do you want to do?</span>
        <div className="desk-segments">
          <Toggle active={intent === "sale"} onClick={() => setIntent("sale")}>
            List for sale
          </Toggle>
          <Toggle
            active={intent === "collection"}
            onClick={() => setIntent("collection")}
          >
            Add to collection
          </Toggle>
        </div>
      </section>
      <section className="desk-defaults" aria-labelledby="batch-defaults">
        <h2 id="batch-defaults">Batch defaults</h2>
        <div className="desk-defaults-row">
          <label>
            Game{" "}
            <Options
              label="Game"
              value={defaults.game}
              options={Object.keys(SCAN_GAMES)}
              disabled={disabled}
              onChange={(game) => changeDefaults({ game })}
            />
          </label>
          <label>
            Language{" "}
            <Options
              label="Batch language"
              value={defaults.language}
              options={SCAN_LANGUAGES}
              disabled={disabled}
              onChange={(language) => changeDefaults({ language })}
            />
          </label>
          <div
            className="desk-segments condition-segments"
            role="group"
            aria-label="Batch condition"
          >
            {SCAN_CONDITIONS.map((condition) => (
              <Toggle
                key={condition}
                active={defaults.condition === condition}
                disabled={disabled}
                onClick={() => changeDefaults({ condition })}
              >
                {condition === "PO" ? "Poor" : condition}
              </Toggle>
            ))}
          </div>
          <label>
            Finish{" "}
            <Options
              label="Batch finish"
              value={defaults.printing}
              options={SCAN_FINISHES}
              disabled={disabled}
              onChange={(printing) => changeDefaults({ printing })}
            />
          </label>
          <div className="desk-segments" role="group" aria-label="Batch flags">
            {Object.entries(FLAGS).map(([key, label]) => (
              <Toggle
                key={key}
                active={defaults[key]}
                disabled={disabled}
                onClick={() => changeDefaults({ [key]: !defaults[key] })}
              >
                {label}
              </Toggle>
            ))}
          </div>
          <datalist id="saved-storage-locations">
            {[...new Set(items.filter(item => item.location?.verified !== false).map(item => item.location?.box).filter(Boolean))].map(box => <option key={box} value={box} />)}
          </datalist>
          <div className="desk-location-default">
            <label>
              Location{" "}
              <input
                aria-label="Batch location"
                maxLength={64}
                value={defaults.storageLabel}
                placeholder="Choose your location"
                list="saved-storage-locations"
                disabled={disabled}
                onChange={(e) =>
                  setDefaults((previous) => ({
                    ...previous,
                    storageLabel: e.target.value,
                  }))
                }
                onBlur={() => {
                  if (defaults.storageLabel !== settings.storageLabel)
                    changeDefaults({ storageLabel: defaults.storageLabel });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <button
              className="desk-gear"
              aria-label="Stack setup"
              aria-expanded={stackOpen}
              onClick={() => setStackOpen(!stackOpen)}
            >
              ⚙ <b>{defaults.stackSize || "Set up"}</b>
            </button>
            {stackOpen && (
              <div
                className="desk-stack-menu"
                role="dialog"
                aria-label="Stack setup"
              >
                <p>
                  Cards between two dividers. Each copy reserves its own
                  position.
                </p>
                {[
                  ["stackSize", "Cards per stack"],
                  ["stack", "Current stack"],
                  ["startPosition", "Next position"],
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      aria-label={label}
                      disabled={disabled}
                      value={defaults[key] ?? ""}
                      onChange={(e) =>
                        setDefaults((previous) => ({
                          ...previous,
                          [key]: e.target.value === "" ? null : Number(e.target.value),
                        }))
                      }
                      onBlur={() => changeDefaults({ [key]: defaults[key] })}
                    />
                  </label>
                ))}
                <div className="desk-segments">
                  {[1, 40, 80, 100].map((size) => (
                    <Toggle
                      key={size}
                      disabled={disabled}
                      active={size === defaults.stackSize}
                      onClick={() => changeDefaults({ stackSize: size })}
                    >
                      {size}
                    </Toggle>
                  ))}
                </div>
                <button className="linkish" onClick={() => setStackOpen(false)}>
                  Done
                </button>
              </div>
            )}
          </div>
          <label className="desk-merge">
            <input
              type="checkbox"
              checked={defaults.mergeRepeats}
              disabled={disabled}
              onChange={(e) =>
                changeDefaults({ mergeRepeats: e.target.checked })
              }
            />{" "}
            Merge repeats
          </label>
        </div>
      </section>
      <section className="desk-manual">
        <span>Add card</span>
        <div className="desk-search">
          <input
            ref={searchInput}
            aria-label="Add card search"
            placeholder="Same as header search — name, set, number…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setResults([]);
              setSearching(e.target.value.trim().length >= 2);
              setDraft(null);
            }}
          />
          {search.trim().length >= 2 && !draft && (
            <div
              className="desk-search-results"
              role="listbox"
              aria-label="Catalog results"
            >
              {searching ? (
                <p>Searching…</p>
              ) : results.length ? (
                results.map((card, index) => (
                  <button
                    key={card.publicId + index}
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      setDraft(card);
                      setDraftQty(1);
                      setDraftPrice(0);
                      setResults([]);
                    }}
                  >
                    <img src={card.art} alt="" />
                    <span>
                      <b>{card.name}</b>
                      <small>
                        {card.setName} · {card.number}
                      </small>
                    </span>
                  </button>
                ))
              ) : (
                <p>No cards found. Try a name, set or number.</p>
              )}
            </div>
          )}
        </div>
        <div className="desk-capture-actions">
          <input
            ref={input}
            type="file"
            accept="image/*"
            capture="environment"
            className="capture-input"
            aria-label="Scan photo"
            onChange={capture}
          />
          <button
            className="btn"
            disabled={disabled || defaults.paused}
            onClick={() => input.current?.click()}
          >
            Upload photo
          </button>
          <button
            className="btn"
            disabled={disabled || camera || defaults.paused}
            onClick={startCamera}
          >
            Camera
          </button>
        </div>
      </section>
      {draft && (
        <form className="desk-draft" onSubmit={addCatalog}>
          <img src={draft.art} alt="" />
          <div>
            <b>{draft.name}</b>
            <small>
              {draft.setName} · {draft.number}
            </small>
          </div>
          <label>
            Quantity
            <input
              type="number"
              aria-label="New card quantity"
              min="1"
              step="1"
              required
              value={draftQty}
              onChange={(e) => setDraftQty(e.target.value)}
            />
          </label>
          {intent === "sale" && (
            <label>
              Price €
              <input
                type="number"
                aria-label="New card price"
                min="0"
                step=".01"
                required
                value={draftPrice}
                onChange={(e) => setDraftPrice(e.target.value)}
              />
            </label>
          )}
          <button
            className="btn btn-primary"
            disabled={disabled || defaults.paused}
          >
            Add to queue
          </button>
          <button
            type="button"
            className="linkish"
            onClick={() => setDraft(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {camera && (
        <div className="desk-camera">
          <video ref={video} autoPlay muted playsInline />
          <div className="desk-camera-frame" />
          <div>
            <button className="btn btn-primary" onClick={shutter}>
              Capture card
            </button>
            <button className="btn" onClick={stopCamera}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="scan-alert" role="alert">
          {error}
          <button className="linkish" onClick={() => setError("")}>
            Dismiss
          </button>
        </p>
      )}
      {rows.some(row => !row.location) && <p className="scan-alert" role="status">Choose your physical location and cards per stack. Positions are reserved when you add this batch to inventory.</p>}
      <div className="desk-toolbar">
        <div className="desk-counts">
          <strong>{count}</strong> cards · {rows.length} rows{" "}
          {unidentified > 0 && (
            <span className="review-chip">{unidentified} unidentified</span>
          )}
        </div>
        <div className="desk-submit-group">
          {intent === "sale" && (
            <div className="desk-targets">
              <span>Add to</span>
              {[
                ["rail", "Card Rails"],
                ["pokoin", "Pokoin"],
                ["cardtrader", "CardTrader"],
              ].map(([key, label]) => (
                <Toggle
                  key={key}
                  active={target === key}
                  onClick={() => setTarget(key)}
                >
                  {label}
                </Toggle>
              ))}
            </div>
          )}
          <button
            className="btn desk-submit"
            disabled={
              disabled ||
              !rows.length ||
              unidentified > 0 ||
              invalid ||
              channelBlocked
            }
            onClick={commit}
          >
            {title}
          </button>
        </div>
      </div>
      {channelBlocked && (
        <div className="desk-channel-note">
          {target === "pokoin"
            ? "Pokoin seller publishing is not available for Card Rails yet."
            : links.cardtrader?.status === "connected"
              ? "Save the batch to Card Rails, then link the exact CardTrader listings from Inventory."
              : "Connect your CardTrader seller account before mapping inventory."}{" "}
          <button className="linkish" onClick={onChannels}>
            Open Platforms
          </button>
        </div>
      )}
      <div className="pokemon-table-wrap">
        <table className="pokemon-table" aria-label="Scan queue">
          <thead>
            <tr>
              <th>#</th>
              <th>Card</th>
              <th>Lang</th>
              <th>Cond</th>
              <th>Finish</th>
              <th>Flags</th>
              <th>Location</th>
              <th>Qty</th>
              {intent === "sale" && <th>Price €</th>}
              <th>State</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {pending && (
              <tr className="pending-scan">
                <td>…</td>
                <td>
                  <div className="queue-card">
                    <img src={pending.dataUrl} alt="Scanned photo" />
                    <span>
                      {working
                        ? "Recognizing card…"
                        : "Photo not saved. Please retry."}
                    </span>
                  </div>
                </td>
                <td colSpan={9} />
              </tr>
            )}
            {!rows.length && !pending && (
              <tr>
                <td colSpan={11}>
                  <p className="desk-empty">
                    Search above to add a card, or connect your phone to scan.
                  </p>
                </td>
              </tr>
            )}
            {rows.map((row, index) => (
              <tr
                key={row.id}
                className={selected === row.id ? "selected" : ""}
              >
                <td>{index + 1}</td>
                <td>
                  <button
                    className="queue-card"
                    onClick={() =>
                      setSelected(selected === row.id ? null : row.id)
                    }
                  >
                    <img src={displayPhoto(row)} alt={row.identity.name} />
                    <span>
                      <b>{row.identity.name}</b>
                      <small>
                        {row.identity.setName} · {row.identity.number}
                      </small>
                    </span>
                  </button>
                </td>
                <td>
                  <Options
                    label={`Language ${index + 1}`}
                    options={SCAN_LANGUAGES}
                    value={row.language}
                    disabled={disabled}
                    onChange={(language) => patch(row.id, { language })}
                  />
                </td>
                <td>
                  <Options
                    label={`Condition ${index + 1}`}
                    options={["M", ...SCAN_CONDITIONS]}
                    value={row.condition}
                    disabled={disabled}
                    onChange={(condition) => patch(row.id, { condition })}
                  />
                </td>
                <td>
                  <Options
                    label={`Finish ${index + 1}`}
                    options={SCAN_FINISHES}
                    value={row.printing}
                    disabled={disabled}
                    onChange={(printing) => patch(row.id, { printing })}
                  />
                </td>
                <td>
                  <div className="desk-row-flags">
                    {Object.entries(FLAGS).map(([key, label]) => (
                      <Toggle
                        key={key}
                        label={`${label} ${index + 1}`}
                        active={row[key]}
                        disabled={disabled}
                        onClick={() => patch(row.id, { [key]: !row[key] })}
                      >
                        {key === "firstEdition"
                          ? "1st"
                          : key === "signed"
                            ? "S"
                            : "A"}
                      </Toggle>
                    ))}
                  </div>
                </td>
                <td className="desk-row-location">
                  <input
                    aria-label={`Location ${index + 1}`}
                    value={row.storageLabel || ""}
                    placeholder="Location"
                    maxLength={64}
                    disabled={disabled}
                    onChange={(e) =>
                      patch(row.id, { storageLabel: e.target.value })
                    }
                  />
                  <small>{scanSlotText(row)}</small>
                </td>
                <td>
                  <input
                    aria-label={`Quantity ${index + 1}`}
                    type="number"
                    min="1"
                    step="1"
                    value={row.quantity}
                    disabled={disabled}
                    onChange={(e) =>
                      patch(row.id, {
                        quantity:
                          e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </td>
                {intent === "sale" && (
                  <td>
                    <input
                      aria-label={`Price ${index + 1}`}
                      type="number"
                      min="0"
                      step=".01"
                      value={row.price}
                      disabled={disabled}
                      onChange={(e) =>
                        patch(row.id, {
                          price:
                            e.target.value === "" ? "" : Number(e.target.value),
                        })
                      }
                    />
                  </td>
                )}
                <td>
                  <button
                    className={
                      "queue-state" +
                      (row.needsIdentification && !patches[row.id]?.identity
                        ? " review"
                        : "")
                    }
                    onClick={() =>
                      setSelected(selected === row.id ? null : row.id)
                    }
                  >
                    {row.needsIdentification && !patches[row.id]?.identity
                      ? "Identify"
                      : row.scanConfidence < 0.8 &&
                          row.source === "scan" &&
                          !patches[row.id]?.identity
                        ? "Check"
                        : "Ready"}
                  </button>
                </td>
                <td>
                  <button
                    className="queue-remove"
                    aria-label={`Remove ${row.identity.name}`}
                    disabled={disabled}
                    onClick={() => remove(row)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {correction}
      {noticeBar}
      {help && (
        <div
          className="desk-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHelp(false);
          }}
        >
          <section
            className="desk-help-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
          >
            <h2>Scan desk shortcuts</h2>
            <p>
              <kbd>/</kbd> Search a card
            </p>
            <p>
              <kbd>⌘ / Ctrl + Enter</kbd> Add the queue to inventory or
              collection
            </p>
            <p>
              <kbd>Esc</kbd> Close the camera, review or this panel
            </p>
            <p>
              Batch defaults apply to queued cards and the next scan. Merge
              repeats combines matching cards with the same language, condition,
              finish, flags and location.
            </p>
            <button className="btn" autoFocus onClick={() => setHelp(false)}>
              Close
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
