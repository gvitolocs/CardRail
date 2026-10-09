import test from "node:test";
import assert from "node:assert/strict";
import { emptyWorkspace } from "../server/workspace.js";
import { mutateInventory } from "../server/inventory.js";

function stage(workspace, key, extra = {}) {
  workspace.scanSettings.mergeRepeats = false;
  mutateInventory(workspace, {
    action: "stage-scan",
    idempotencyKey: key,
    item: {
      identity: {
        game: "pokemon",
        name: "Bulbasaur",
        setName: "Base Set",
        number: "44/102",
      },
      quantity: 1,
      price: 0,
      language: "EN",
      condition: "NM",
      printing: "Standard",
      scanPhoto: { dataUrl: "data:image/jpeg;base64,/9j/AA==" },
    },
    ...extra,
  });
  return workspace.scanQueue.at(-1);
}

test("scanned photos persist in a separate queue without changing stock or channel delivery", () => {
  const workspace = emptyWorkspace();
  const row = stage(workspace, "stage-1");
  assert.equal(workspace.items.length, 0);
  assert.equal(workspace.scanQueue.length, 1);
  assert.equal(workspace.book.length, 0);
  assert.equal(workspace.outbox.length, 0);
  assert.equal(row.scanPhoto.dataUrl, "data:image/jpeg;base64,/9j/AA==");
  assert.equal(
    mutateInventory(workspace, {
      action: "stage-scan",
      idempotencyKey: "stage-1",
    }),
    null,
  );
  assert.equal(workspace.scanQueue.length, 1);
});

test("adding a batch applies row edits, preserves each photo, and allocates unique current shelf positions", () => {
  const workspace = emptyWorkspace();
  workspace.scanSettings = { ...workspace.scanSettings, storageLabel: "05", stackSize: 40 };
  const a = stage(workspace, "stage-a");
  const b = stage(workspace, "stage-b");
  const hash = a.scanPhoto.sha256;
  workspace.items.push({
    ...structuredClone(a),
    id: "existing",
    location: { box: "05", row: "2", position: 2107 },
  });
  mutateInventory(workspace, {
    action: "commit-scans",
    idempotencyKey: "commit-batch",
    ids: [a.id, b.id],
    patches: {
      [a.id]: { quantity: 5, price: 12, condition: "SP", printing: "Holo" },
    },
  });
  assert.equal(workspace.scanQueue.length, 0);
  assert.equal(workspace.items[1].quantity, 5);
  assert.equal(workspace.items[1].price, 12);
  assert.equal(workspace.items[1].condition, "SP");
  assert.equal(workspace.items[1].printing, "Holo");
  assert.equal(workspace.items[1].scanPhoto.sha256, hash);
  assert.deepEqual(
    workspace.items.slice(1).map((row) => row.location.position),
    [2108, 2113],
  );
  assert.equal(
    mutateInventory(workspace, {
      action: "commit-scans",
      idempotencyKey: "commit-batch",
      ids: [a.id, b.id],
    }),
    null,
  );
  assert.equal(workspace.items.length, 3);
});

test("unidentified photos cannot enter inventory until their identity is corrected", () => {
  const workspace = emptyWorkspace();
  workspace.scanSettings = { ...workspace.scanSettings, storageLabel: "Shelf A", stackSize: 20 };
  const row = stage(workspace, "unknown", { needsIdentification: true });
  assert.throws(
    () =>
      mutateInventory(workspace, {
        action: "commit-scans",
        idempotencyKey: "bad",
        ids: [row.id],
      }),
    /Identify every card/,
  );
  assert.equal(workspace.items.length, 0);
  assert.equal(workspace.scanQueue.length, 1);
  mutateInventory(workspace, {
    action: "commit-scans",
    idempotencyKey: "corrected",
    ids: [row.id],
    patches: {
      [row.id]: {
        identity: { name: "Charmander", setName: "Base Set", number: "46/102" },
      },
    },
  });
  assert.equal(workspace.items[0].identity.name, "Charmander");
  assert.equal(workspace.scanQueue.length, 0);
});

test("removing a staged photo leaves stock unchanged and stale batch references are rejected", () => {
  const workspace = emptyWorkspace();
  const row = stage(workspace, "remove-me");
  mutateInventory(workspace, {
    action: "remove-scan",
    idempotencyKey: "remove",
    id: row.id,
  });
  assert.equal(workspace.items.length, 0);
  assert.equal(workspace.scanQueue.length, 0);
  assert.throws(
    () =>
      mutateInventory(workspace, {
        action: "commit-scans",
        idempotencyKey: "stale",
        ids: [row.id],
      }),
    /changed/,
  );
});

test("merge repeats respects variant flags and keeps the original scan photo", () => {
  const workspace = emptyWorkspace();
  const item = {
    identity: {
      game: "pokemon",
      name: "Pikachu",
      setName: "Base",
      number: "58",
    },
    quantity: 1,
    price: 0,
    language: "EN",
    condition: "NM",
    printing: "Standard",
    scanPhoto: { dataUrl: "data:image/jpeg;base64,/9j/AA==" },
  };
  const capture = (key) =>
    mutateInventory(workspace, {
      action: "stage-scan",
      idempotencyKey: key,
      item,
    });
  capture("one");
  const first = workspace.scanQueue[0].scanPhoto;
  capture("two");
  assert.equal(workspace.scanQueue.length, 1);
  assert.equal(workspace.scanQueue[0].quantity, 2);
  assert.deepEqual(workspace.scanQueue[0].scanPhoto, first);
  mutateInventory(workspace, {
    action: "stage-scan",
    idempotencyKey: "signed",
    item,
    defaults: { signed: true },
  });
  assert.equal(workspace.scanQueue.length, 2);
  assert.equal(workspace.scanQueue[1].signed, true);
});

test("catalog additions, shared defaults, collection and undo persist without fabricating scan photos", () => {
  const workspace = emptyWorkspace();
  const item = {
    identity: {
      game: "pokemon",
      name: "Pikachu",
      setName: "Base",
      number: "58",
    },
    quantity: 3,
    price: 5,
    language: "EN",
    condition: "NM",
    printing: "Standard",
    art: "https://pokoin.com/card-images/pikachu.jpg",
  };
  mutateInventory(workspace, {
    action: "stage-catalog",
    idempotencyKey: "catalog",
    item,
  });
  const id = workspace.scanQueue[0].id;
  assert.equal(workspace.scanQueue[0].scanPhoto, null);
  mutateInventory(workspace, {
    action: "scan-defaults",
    idempotencyKey: "defaults",
    patch: { condition: "SP", signed: true, storageLabel: "ETB", stackSize: 2 },
  });
  assert.equal(workspace.scanQueue[0].condition, "SP");
  mutateInventory(workspace, {
    action: "remove-scan",
    idempotencyKey: "delete",
    id,
  });
  mutateInventory(workspace, {
    action: "restore-scan",
    idempotencyKey: "undo",
    id,
  });
  mutateInventory(workspace, {
    action: "commit-scans",
    idempotencyKey: "collection",
    ids: [id],
    intent: "collection",
  });
  assert.equal(workspace.items[0].purpose, "collection");
  assert.equal(workspace.items[0].price, 0);
  assert.deepEqual(workspace.items[0].location, {
    box: "ETB",
    row: "1",
    position: 1,
    end: 3,
    stackSize: 2,
    verified: true,
  });
  assert.equal(workspace.outbox.length, 0);
});

test("pause prevents new captures until resumed and collection cards cannot be sold", async () => {
  const { recordSale } = await import("../server/inventory.js");
  const workspace = emptyWorkspace();
  mutateInventory(workspace, {
    action: "scan-defaults",
    idempotencyKey: "pause",
    patch: { paused: true },
  });
  assert.throws(
    () =>
      mutateInventory(workspace, {
        action: "stage-catalog",
        idempotencyKey: "paused",
        item: {
          identity: {
            game: "pokemon",
            name: "Pikachu",
            setName: "Base",
            number: "58",
          },
          quantity: 1,
          price: 0,
          language: "EN",
          condition: "NM",
          printing: "Standard",
        },
      }),
    /paused/,
  );
  assert.equal(workspace.scanQueue.length, 0);
  workspace.items = [{ id: "collection", purpose: "collection" }];
  assert.throws(
    () =>
      recordSale(workspace, {
        itemId: "collection",
        quantity: 1,
        channel: "rail",
        orderRef: "a",
        lineId: "1",
      }),
    /collection/,
  );
});


test("empty desks never invent a physical position; staged cards require seller storage configuration", () => {
  const workspace = emptyWorkspace();
  assert.equal(workspace.scanSettings.storageLabel, "");
  assert.equal(workspace.scanSettings.stackSize, null);
  const row = stage(workspace, "unconfigured");
  assert.equal(row.location, null);
  assert.throws(() => mutateInventory(workspace, { action: "commit-scans", ids: [row.id], idempotencyKey: "blocked" }), /real location/);
  assert.equal(workspace.items.length, 0);
  mutateInventory(workspace, { action: "scan-defaults", patch: { storageLabel: "Owner box", stackSize: 10 }, idempotencyKey: "owner-settings" });
  mutateInventory(workspace, { action: "commit-scans", ids: [row.id], idempotencyKey: "configured" });
  assert.equal(workspace.items[0].location.position, 1);
  assert.equal(workspace.items[0].location.box, "Owner box");
});

test("legacy automatic settings require confirmation without destroying old inventory", async () => {
  const { normalizeScanSettings, allocateScanLocations } = await import("../src/core/scanDesk.js");
  const workspace = emptyWorkspace();
  workspace.scanSettings.storageLabel = "05"; workspace.scanSettings.stackSize = 80;
  workspace.items = [{ id: "old", source: "scan", quantity: 1, location: { box: "05", row: "1", position: 2100 } }];
  normalizeScanSettings(workspace);
  assert.equal(workspace.scanSettings.storageLabel, "");
  assert.equal(workspace.items[0].location.position, 2100);
  assert.equal(workspace.items[0].location.verified, false);
  const [real] = allocateScanLocations(workspace.items, [{ storageLabel: "05", stackSize: 80, quantity: 2 }]);
  assert.equal(real.location.position, 1);
  workspace.scanSettings = { ...workspace.scanSettings, storageLabel: "05", stackSize: 80, locationConfigured: true };
  normalizeScanSettings(workspace);
  assert.equal(workspace.scanSettings.storageLabel, "05");
});
