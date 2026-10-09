import { randomUUID, createHash } from "node:crypto";
import { syncAdjust, syncSale, syncReconcile } from "../src/engine/sync.js";
import { locationCode } from "../src/core/canonical.js";

import {
  SCAN_DEFAULTS,
  SCAN_LANGUAGES,
  SCAN_GAMES,
  allocateScanLocations,
  sameScanVariant,
} from "../src/core/scanDesk.js";

const CHANNELS = ["pokoin", "cardtrader", "cardmarket", "ebay"];
function requireValue(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { status: 400 });
}
function text(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createItem(input, _items, catalog = false) {
  const identity = Object.fromEntries(
    ["game", "name", "setName", "number"].map((key) => [
      key,
      text(input.identity?.[key]),
    ]),
  );
  requireValue(
    Object.values(identity).every(Boolean),
    "Game, name, set and card number are required.",
  );
  requireValue(
    Number.isSafeInteger(input.quantity) && input.quantity > 0,
    "Quantity must be a positive whole number.",
  );
  requireValue(
    Number.isFinite(input.price) && input.price >= 0,
    "Price must be zero or greater.",
  );
  requireValue(
    ["EN", "IT", "JP", "ZH", "DE", "FR", "ES", "PT", "KO"].includes(
      input.language,
    ),
    "Choose a card language.",
  );
  requireValue(
    ["M", "NM", "SP", "MP", "PL", "PO"].includes(input.condition),
    "Choose a card condition.",
  );
  const printing = text(input.printing, 60);
  requireValue(printing, "Finish is required.");
  const dataUrl = catalog ? undefined : input.scanPhoto?.dataUrl;
  requireValue(
    catalog ||
      (typeof dataUrl === "string" &&
        dataUrl.length < 2800000 &&
        /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)),
    "A captured JPEG photo under 2 MB is required.",
  );
  const decoded = Buffer.from(dataUrl?.split(",")[1] || "", "base64");
  requireValue(
    catalog || (decoded[0] === 255 && decoded[1] === 216 && decoded[2] === 255),
    "Invalid JPEG photo.",
  );
  const sha256 = createHash("sha256")
    .update(dataUrl || "catalog")
    .digest("hex");
  const at = new Date().toISOString();
  return {
    id: `cr_${randomUUID()}`,
    identity: {
      ...identity,
      publicId: text(input.identity?.publicId),
      cardtraderBlueprintId: text(input.identity?.cardtraderBlueprintId),
    },
    art: text(input.art, 500),
    language: input.language,
    condition: input.condition,
    printing,
    quantity: input.quantity,
    price: input.price,
    currency: "EUR",
    source: catalog ? "catalog" : "scan",
    location: null,
    scanPhoto: catalog
      ? null
      : {
          id: `photo_${sha256.slice(0, 18)}`,
          sha256,
          dataUrl,
          bytes: decoded.length,
          capturedAt: at,
          role: "scan",
        },
    listings: [],
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

export function recordResult(workspace, result) {
  if (!result.event || result.event.duplicate) return workspace;
  workspace.items = workspace.items.map((item) =>
    item.id === result.item.id ? result.item : item,
  );
  const id = `event_${createHash("sha256").update(result.event.key).digest("hex").slice(0, 32)}`;
  result.event.id = id;
  if (result.ledgerRow) result.ledgerRow.id = id;
  workspace.events.unshift(result.event);
  if (result.ledgerRow) workspace.book.unshift(result.ledgerRow);
  if (result.event.oversell)
    workspace.events.unshift({
      id: `${id}_oversell`,
      at: result.event.at,
      cause: "oversell_exception",
      itemId: result.item.id,
      name: result.item.identity.name,
      oversell: result.event.oversell,
      intents: [],
    });
  for (const intent of result.event.intents) {
    if (
      intent.action === "observe_sale" ||
      intent.action === "observe_cancel"
    ) {
      // An origin notification must not erase an older, undelivered change
      // from Card Rails. Retain that operation and rebase its target; this
      // notification itself never creates a write-back to the origin.
      for (const queued of workspace.outbox.filter(
        (i) =>
          i.itemId === result.item.id &&
          i.platform === intent.platform &&
          i.listingId === intent.listingId,
      )) {
        queued.targetQuantity = result.item.quantity;
        queued.requiresRead = true;
      }
      continue;
    }
    // No delivery is claimed until a verified channel adapter acknowledges it.
    // Supersede unsent targets so delta channels don't receive overlapping changes.
    workspace.outbox = workspace.outbox.filter(
      (i) =>
        !(
          i.itemId === result.item.id &&
          i.platform === intent.platform &&
          i.listingId === intent.listingId
        ),
    );
    if (intent.write)
      workspace.outbox.push({
        ...intent,
        itemId: result.item.id,
        eventId: result.event.id,
        status:
          workspace.links[intent.platform]?.status === "connected"
            ? "queued"
            : "blocked",
        reason:
          workspace.links[intent.platform]?.status === "connected"
            ? ""
            : "Connect this channel to deliver stock updates",
      });
  }
  return workspace;
}

function applyScanPatch(item, patch) {
  for (const field of ["firstEdition", "signed", "altered"]) {
    if (patch[field] !== undefined) {
      requireValue(typeof patch[field] === "boolean", "Invalid card flag.");
      item[field] = patch[field];
    }
  }
  if (patch.storageLabel !== undefined) {
    item.storageLabel = text(patch.storageLabel, 64);
  }
  for (const field of ["stackSize", "stack", "startPosition"]) {
    if (patch[field] !== undefined) {
      if (field === "stackSize" && patch[field] === null) { item[field] = null; continue; }
      requireValue(
        Number.isSafeInteger(patch[field]) &&
          patch[field] > 0 &&
          patch[field] <= 10000,
        "Invalid stack position.",
      );
      item[field] = patch[field];
    }
  }
  if (patch.identity) {
    requireValue(
      ["name", "setName", "number"].every(
        (field) =>
          text(patch.identity[field]) &&
          !["—", "Carta da identificare"].includes(text(patch.identity[field])),
      ),
      "Card name, set and number are required.",
    );
    item.identity = {
      ...item.identity,
      ...Object.fromEntries(
        ["name", "setName", "number", "publicId", "cardtraderBlueprintId"].map(
          (field) => [field, text(patch.identity[field])],
        ),
      ),
    };
    item.needsIdentification = false;
  }
  if (patch.language !== undefined) {
    requireValue(
      ["EN", "IT", "JP", "ZH", "DE", "FR", "ES", "PT", "KO"].includes(
        patch.language,
      ),
      "Choose a card language.",
    );
    item.language = patch.language;
  }
  if (patch.condition !== undefined) {
    requireValue(
      ["M", "NM", "SP", "MP", "PL", "PO"].includes(patch.condition),
      "Choose a card condition.",
    );
    item.condition = patch.condition;
  }
  if (patch.printing !== undefined) {
    requireValue(text(patch.printing, 60), "Finish required.");
    item.printing = text(patch.printing, 60);
  }
  if (patch.quantity !== undefined) {
    requireValue(
      Number.isSafeInteger(patch.quantity) && patch.quantity > 0,
      "Quantity must be a positive whole number.",
    );
    item.quantity = patch.quantity;
  }
  if (patch.price !== undefined) {
    requireValue(
      Number.isFinite(patch.price) && patch.price >= 0,
      "Enter a valid price.",
    );
    item.price = patch.price;
  }
}

export function mutateInventory(workspace, input, savedPhoto = null) {
  const key = text(input.idempotencyKey, 200);
  requireValue(key, "An idempotency key is required.");
  if (workspace.events.some((e) => e.key === key)) return null;
  workspace.scanQueue ||= [];
  workspace.scanSettings ||= { ...SCAN_DEFAULTS };
  if (input.action === "scan-defaults") {
    const patch = input.patch || {};
    requireValue(
      Object.keys(patch).every((key) => key in SCAN_DEFAULTS),
      "Unknown batch default.",
    );
    requireValue(
      patch.game === undefined || Boolean(SCAN_GAMES[patch.game]),
      "Choose a game.",
    );
    requireValue(
      patch.language === undefined || SCAN_LANGUAGES.includes(patch.language),
      "Choose a language.",
    );
    const next = { ...workspace.scanSettings };
    applyScanPatch(next, patch);
    for (const field of ["mergeRepeats", "paused"]) {
      if (patch[field] !== undefined) {
        requireValue(
          typeof patch[field] === "boolean",
          "Invalid scan setting.",
        );
        next[field] = patch[field];
      }
    }
    if (patch.game !== undefined) next.game = patch.game;
    if (patch.storageLabel !== undefined || patch.stackSize !== undefined) next.locationConfigured = true;
    workspace.scanSettings = next;
    for (const row of workspace.scanQueue) applyScanPatch(row, patch);
    workspace.events.unshift({
      id: randomUUID(),
      key,
      at: new Date().toISOString(),
      cause: "scan-defaults",
      delta: 0,
      intents: [],
    });
    return workspace;
  }
  if (input.action === "restore-scan") {
    const row = (workspace.scanTrash || []).find((row) => row.id === input.id);
    requireValue(row, "Scanned card cannot be restored.");
    workspace.scanQueue.push(row);
    workspace.scanTrash = workspace.scanTrash.filter(
      (item) => item.id !== row.id,
    );
    workspace.events.unshift({
      id: randomUUID(),
      key,
      at: new Date().toISOString(),
      cause: "restore-scan",
      delta: 0,
      intents: [],
    });
    return workspace;
  }
  if (["stage-scan", "stage-catalog"].includes(input.action)) {
    const item = createItem(
      input.item || {},
      [...workspace.items, ...workspace.scanQueue],
      input.action === "stage-catalog",
    );
    const settings = { ...workspace.scanSettings, ...input.defaults };
    applyScanPatch(item, settings);
    requireValue(
      !workspace.scanSettings.paused,
      "Scan paused. Resume on the dashboard.",
    );
    if (savedPhoto) item.scanPhoto = savedPhoto;
    item.scanCandidates = Array.isArray(input.candidates)
      ? input.candidates.slice(0, 5).map((card) => ({
          name: text(card.name),
          setName: text(card.setName),
          number: text(card.number),
          publicId: text(card.publicId),
          cardtraderBlueprintId: text(card.cardtraderBlueprintId),
          art: text(card.art, 500),
          score: Number(card.score) || 0,
        }))
      : [];
    item.scanConfidence = Number(input.confidence) || 0;
    item.needsIdentification = input.needsIdentification === true;
    const match =
      workspace.scanSettings.mergeRepeats &&
      !item.needsIdentification &&
      workspace.scanQueue.find(
        (row) => !row.needsIdentification && sameScanVariant(row, item),
      );
    if (match) {
      match.quantity += item.quantity;
      if (item.scanPhoto && !match.scanPhoto) {
        match.scanPhoto = item.scanPhoto;
        match.source = "scan";
      }
      match.scanCandidates = item.scanCandidates;
      match.scanConfidence = item.scanConfidence;
    } else workspace.scanQueue.push(item);
    workspace.events.unshift({
      id: randomUUID(),
      key,
      at: item.createdAt,
      cause: match ? "scan_merged" : "scan_staged",
      itemId: match?.id || item.id,
      name: item.identity.name,
      delta: 0,
      intents: [],
    });
    return workspace;
  }
  if (input.action === "edit-scan" || input.action === "remove-scan") {
    const item = workspace.scanQueue.find((row) => row.id === input.id);
    requireValue(item, "Scanned card not found.");
    if (input.action === "remove-scan") {
      workspace.scanTrash = [item, ...(workspace.scanTrash || [])].slice(0, 10);
      workspace.scanQueue = workspace.scanQueue.filter(
        (row) => row.id !== item.id,
      );
    } else {
      applyScanPatch(item, input.patch || {});
    }
    workspace.events.unshift({
      id: randomUUID(),
      key,
      at: new Date().toISOString(),
      cause: input.action,
      itemId: item.id,
      delta: 0,
      intents: [],
    });
    return workspace;
  }
  if (input.action === "commit-scans") {
    requireValue(
      Array.isArray(input.ids) && input.ids.length > 0,
      "Select scanned cards.",
    );
    const rows = workspace.scanQueue
      .filter((row) => input.ids.includes(row.id))
      .map((row) => structuredClone(row));
    requireValue(
      rows.length === new Set(input.ids).size,
      "A scanned card changed. Refresh the queue.",
    );
    for (const row of rows) applyScanPatch(row, input.patches?.[row.id] || {});
    requireValue(
      rows.every((row) => !row.needsIdentification),
      "Identify every card before adding it to inventory.",
    );
    const allocated = allocateScanLocations(workspace.items, rows);
    requireValue(allocated.every(row => row.location), "Set a real location and stack capacity before adding cards to inventory.");
    for (const row of allocated) {
      row.purpose = input.intent === "collection" ? "collection" : "sale";
      if (row.purpose === "collection") row.price = 0;
      delete row.scanCandidates;
      delete row.scanConfidence;
      delete row.needsIdentification;
      workspace.items.push(row);
      workspace.events.unshift({
        id: randomUUID(),
        key,
        at: new Date().toISOString(),
        cause: "scan_capture",
        itemId: row.id,
        name: row.identity.name,
        delta: row.quantity,
        intents: [],
      });
    }
    workspace.scanQueue = workspace.scanQueue.filter(
      (row) => !input.ids.includes(row.id),
    );
    return workspace;
  }
  if (input.action === "create") {
    const created = createItem(input.item || {}, workspace.items);
    applyScanPatch(created, { ...workspace.scanSettings, ...input.defaults });
    const [item] = allocateScanLocations(workspace.items, [created]);
    requireValue(item.location, "Set a real location and stack capacity before adding cards to inventory.");
    if (savedPhoto) item.scanPhoto = savedPhoto;
    workspace.items.push(item);
    workspace.events.unshift({
      id: randomUUID(),
      key,
      at: item.createdAt,
      cause: "scan_capture",
      itemId: item.id,
      name: item.identity.name,
      delta: item.quantity,
      intents: [],
    });
    return workspace;
  }
  if (input.action === "pick") {
    requireValue(
      workspace.book.some((row) => row.id === input.key),
      "Sale line not found.",
    );
    workspace.pickedKeys = [...new Set([...workspace.pickedKeys, input.key])];
  } else if (input.action === "link") {
    const channel = input.channel;
    requireValue(CHANNELS.includes(channel), "Unknown channel.");
    if (input.linked) {
      requireValue(
        text(input.accountRef),
        "Channel account reference required.",
      );
      if (channel === "cardmarket")
        requireValue(
          workspace.links.pokoin?.linked &&
            input.linkedVia === "pokoin-account-link",
          "Confirm the Pokoin account is linked to Cardmarket.",
        );
    }
    workspace.links[channel] = {
      linked: Boolean(input.linked),
      accountRef: input.linked ? text(input.accountRef) : "",
      linkedVia: channel === "cardmarket" ? "pokoin-account-link" : null,
      status: input.linked ? "awaiting-grant" : "unlinked",
    };
    if (channel === "pokoin" && !input.linked)
      workspace.links.cardmarket = {
        linked: false,
        linkedVia: "pokoin-account-link",
      };
    // A revoked link cannot retain work eligible for delivery.
    workspace.outbox = workspace.outbox.filter(
      (i) => workspace.links[i.platform]?.linked,
    );
  } else if (input.action === "reconcile") {
    requireValue(
      Array.isArray(input.presentIds) &&
        input.presentIds.every((x) => typeof x === "string"),
      "Provide listing IDs from a CardTrader export.",
    );
    const result = syncReconcile(workspace.items, {
      presentIds: input.presentIds,
      complete: input.complete === true,
      confirmEmpty: input.confirmEmpty === true,
    });
    workspace.items = result.items;
    workspace.events.unshift({ ...result.event, key });
    return workspace;
  } else {
    const item = workspace.items.find((i) => i.id === input.id);
    requireValue(item, "Inventory row not found.");
    if (input.action === "edit") {
      const patch = input.patch || {};
      requireValue(
        !item.listings.some(
          (l) => l.status === "live" || l.status === "sold_out",
        ) ||
          !["language", "condition", "printing"].some(
            (field) => patch[field] && patch[field] !== item[field],
          ),
        "A listed card’s variant cannot change. Keep its language, condition and finish, or capture a separate inventory row.",
      );
      if (patch.price !== undefined) {
        requireValue(
          Number.isFinite(patch.price) && patch.price >= 0,
          "Enter a valid price.",
        );
        item.price = patch.price;
      }
      if (patch.language !== undefined)
        requireValue(
          ["EN", "IT", "JP", "ZH", "DE", "FR", "ES", "PT", "KO"].includes(
            patch.language,
          ),
          "Choose a card language.",
        );
      if (patch.condition !== undefined)
        requireValue(
          ["M", "NM", "SP", "MP", "PL", "PO"].includes(patch.condition),
          "Choose a card condition.",
        );
      for (const field of ["language", "condition", "printing"])
        if (patch[field]) item[field] = text(patch[field], 60);
      if (patch.location) {
        requireValue(
          text(patch.location.box) &&
            text(patch.location.row) &&
            Number.isSafeInteger(patch.location.position) &&
            patch.location.position > 0,
          "Enter a valid shelf position.",
        );
        item.location = {
          box: text(patch.location.box),
          row: text(patch.location.row),
          position: patch.location.position,
          end: patch.location.position + item.quantity - 1,
          verified: true,
        };
      }
      item.version++;
      item.updatedAt = new Date().toISOString();
      workspace.events.unshift({
        id: randomUUID(),
        key,
        at: item.updatedAt,
        cause: "edit",
        itemId: item.id,
        name: item.identity.name,
        delta: 0,
        intents: [],
      });
      return workspace;
    }
    if (input.action === "adjust") {
      requireValue(
        Number.isSafeInteger(input.delta) &&
          input.delta !== 0 &&
          item.quantity + input.delta >= 0,
        "Stock change must be a whole number and cannot make stock negative.",
      );
      return recordResult(
        workspace,
        syncAdjust(item, input.delta, {
          links: workspace.links,
          idempotencyKey: key,
        }),
      );
    }
    requireValue(input.action === "listing", "Unknown inventory action.");
    requireValue(
      CHANNELS.includes(input.channel) &&
        workspace.links[input.channel]?.linked,
      "Link this channel first.",
    );
    requireValue(
      !workspace.items.some(
        (other) =>
          other.id !== item.id &&
          other.listings.some(
            (l) =>
              l.platform === input.channel &&
              l.externalId === text(input.externalId),
          ),
      ),
      "This channel listing is already linked to another inventory row.",
    );
    requireValue(
      text(input.externalId),
      "An existing channel listing ID is required.",
    );
    requireValue(
      Number.isSafeInteger(input.confirmedQuantity) &&
        input.confirmedQuantity >= 0,
      "Enter the actual confirmed channel quantity.",
    );
    const listing = {
      platform: input.channel,
      externalId: text(input.externalId),
      quantity: input.confirmedQuantity,
      lastSyncedQuantity: input.confirmedQuantity,
      status: "live",
      stockMode: input.channel === "cardtrader" ? "delta" : "absolute",
      syncStatus:
        input.confirmedQuantity === item.quantity ? "synced" : "queued",
      lastSyncedAt: new Date().toISOString(),
    };
    workspace.outbox = workspace.outbox.filter(
      (intent) =>
        !(intent.itemId === item.id && intent.platform === input.channel),
    );
    item.listings = [
      ...item.listings.filter((i) => i.platform !== input.channel),
      listing,
    ];
    item.version++;
    if (item.quantity !== input.confirmedQuantity)
      workspace.outbox.push({
        platform: input.channel,
        listingId: listing.externalId,
        itemId: item.id,
        targetQuantity: item.quantity,
        delta: item.quantity - input.confirmedQuantity,
        write: true,
        mode: listing.stockMode,
        idempotencyKey: `${key}:${input.channel}:${listing.externalId}`,
        status: "queued",
      });
  }
  workspace.events.unshift({
    id: randomUUID(),
    key,
    at: new Date().toISOString(),
    cause: input.action,
    delta: 0,
    intents: [],
  });
  return workspace;
}

export function recordSale(workspace, input) {
  requireValue(
    workspace.items.find((item) => item.id === input.itemId)?.purpose !==
      "collection",
    "This card is in your collection, not for sale.",
  );
  requireValue(
    ["rail", ...CHANNELS].includes(input.channel),
    "Unknown sale channel.",
  );
  requireValue(
    Number.isSafeInteger(input.quantity) && input.quantity > 0,
    "Sale quantity must be a positive whole number.",
  );
  requireValue(
    text(input.orderRef) && text(input.lineId),
    "Order and line references are required for deduplication.",
  );
  const key = `sale:${input.channel}:${text(input.orderRef)}:${text(input.lineId)}`;
  if (workspace.events.some((e) => e.key === key)) return null;
  const item = workspace.items.find((i) => i.id === input.itemId);
  requireValue(item, "Inventory row not found.");
  if (input.channel !== "rail")
    requireValue(
      workspace.links[input.channel]?.linked &&
        item.listings.some((l) => l.platform === input.channel),
      "Map an existing listing on the linked sale channel first.",
    );
  return recordResult(
    workspace,
    syncSale(
      item,
      {
        platform: input.channel,
        quantity: input.quantity,
        orderRef: text(input.orderRef),
        lineId: text(input.lineId),
        idempotencyKey: key,
        externalId: input.externalId,
        observedQuantity: input.observedQuantity,
      },
      { links: workspace.links, location: locationCode(item.location) },
    ),
  );
}
