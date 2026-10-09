import test from "node:test";
import assert from "node:assert/strict";
import { syncSale, syncAdjust, syncReconcile } from "../src/engine/sync.js";
import { mutateInventory, recordSale } from "../server/inventory.js";
import { emptyWorkspace, device, guard } from "../server/workspace.js";
import { buildEbayListing } from "../src/connectors/ebay.js";

function stock() {
  return {
    id: "cr_1",
    identity: {
      game: "pokemon",
      name: "Bulbasaur",
      setName: "Base Set",
      number: "44/102",
    },
    quantity: 5,
    price: 12,
    currency: "EUR",
    language: "EN",
    condition: "NM",
    printing: "Standard",
    version: 1,
    location: { box: "05", row: "1", position: 2100 },
    scanPhoto: {
      id: "scan_1",
      sha256: "same",
      dataUrl: "data:image/jpeg;base64,/9j/AA==",
    },
    listings: ["ebay", "cardtrader", "cardmarket", "pokoin"].map(
      (platform) => ({
        platform,
        externalId: platform + "-1",
        quantity: 5,
        lastSyncedQuantity: 5,
        status: "live",
      }),
    ),
  };
}
const links = Object.fromEntries(
  ["pokoin", "cardtrader", "cardmarket", "ebay"].map((platform) => [
    platform,
    {
      linked: true,
      status: "connected",
      linkedVia: platform === "cardmarket" ? "pokoin-account-link" : null,
    },
  ]),
);

test("Card Rails sale is saved first; targets ordered Pokoin, Cardmarket, CardTrader, eBay", () => {
  const result = syncSale(
    stock(),
    { platform: "rail", quantity: 1, orderRef: "A", lineId: "1" },
    { links },
  );
  assert.equal(result.item.quantity, 4);
  assert.deepEqual(
    result.event.intents.map((i) => i.platform),
    ["pokoin", "cardmarket", "cardtrader", "ebay"],
  );
  assert.equal(
    result.event.intents.find((i) => i.platform === "cardtrader").mode,
    "delta",
  );
  assert.equal(
    result.event.intents.find((i) => i.platform === "cardtrader").delta,
    -1,
  );
  assert.equal(
    result.item.listings.find((i) => i.platform === "cardtrader")
      .lastSyncedQuantity,
    5,
  );
});
test("unsent changes converge from confirmed stock and supersede pending targets", () => {
  let workspace = { ...emptyWorkspace(), items: [stock()], links };
  workspace = recordSale(workspace, {
    itemId: "cr_1",
    channel: "rail",
    quantity: 1,
    orderRef: "A",
    lineId: "1",
  });
  workspace = recordSale(workspace, {
    itemId: "cr_1",
    channel: "rail",
    quantity: 1,
    orderRef: "B",
    lineId: "1",
  });
  assert.equal(workspace.items[0].quantity, 3);
  assert.equal(workspace.outbox.length, 4);
  assert.equal(
    workspace.outbox.find((i) => i.platform === "cardtrader").delta,
    -2,
  );
  assert.ok(workspace.outbox.every((i) => i.status === "queued"));
});
test("origin sale is observed without echo; divergent channel mirror stays separate", () => {
  const item = stock();
  item.listings.find((i) => i.platform === "cardtrader").lastSyncedQuantity = 8;
  const result = syncSale(
    item,
    { platform: "cardtrader", quantity: 1, orderRef: "C", lineId: "1" },
    { links },
  );
  assert.equal(result.item.quantity, 4);
  assert.equal(
    result.item.listings.find((i) => i.platform === "cardtrader")
      .lastSyncedQuantity,
    8,
  );
  assert.equal(
    result.item.listings.find((i) => i.platform === "cardtrader").requiresRead,
    true,
  );
  assert.equal(
    result.event.intents.find((i) => i.platform === "cardtrader").write,
    false,
  );
});
test("duplicate order line is not deducted twice even if quantity differs", () => {
  const workspace = { ...emptyWorkspace(), items: [stock()], links };
  recordSale(workspace, {
    itemId: "cr_1",
    channel: "rail",
    quantity: 1,
    orderRef: "A",
    lineId: "1",
  });
  assert.equal(
    recordSale(workspace, {
      itemId: "cr_1",
      channel: "rail",
      quantity: 2,
      orderRef: "A",
      lineId: "1",
    }),
    null,
  );
  assert.equal(workspace.items[0].quantity, 4);
  assert.equal(workspace.book.length, 1);
  assert.equal(workspace.book[0].location, "B05-R1-2100");
});
test("incomplete and suspicious empty exports never remove stock", () => {
  for (const options of [
    { complete: false, presentIds: [] },
    { complete: true, presentIds: [] },
    { complete: true, presentIds: ["unrelated"], confirmEmpty: true },
  ]) {
    const result = syncReconcile([stock()], options);
    assert.equal(result.items[0].quantity, 5);
  }
});
test("Cardmarket requires explicit linked Pokoin account and linkedVia", () => {
  const result = syncAdjust(stock(), -1, {
    links: { cardmarket: { linked: true } },
    idempotencyKey: "adj",
  });
  assert.ok(result.event.intents.every((i) => !i.write));
  const workspace = emptyWorkspace();
  assert.throws(
    () =>
      mutateInventory(workspace, {
        action: "link",
        channel: "cardmarket",
        linked: true,
        accountRef: "CM",
        linkedVia: "pokoin-account-link",
        idempotencyKey: "l",
      }),
    /Pokoin/,
  );
});
test("oversells are visible and invalid quantities are rejected", () => {
  const workspace = {
    ...emptyWorkspace(),
    items: [{ ...stock(), quantity: 0 }],
    links,
  };
  recordSale(workspace, {
    itemId: "cr_1",
    channel: "rail",
    quantity: 2,
    orderRef: "O",
    lineId: "1",
  });
  assert.equal(workspace.items[0].quantity, 0);
  assert.equal(workspace.book[0].oversell, 2);
  assert.throws(
    () =>
      recordSale(workspace, {
        itemId: "cr_1",
        channel: "rail",
        quantity: NaN,
        orderRef: "N",
        lineId: "1",
      }),
    /quantity/,
  );
  assert.throws(() => syncAdjust(stock(), 0.5), /whole/);
});
test("eBay uses exact saved scan photo and all identity fields", () => {
  const item = stock(),
    draft = buildEbayListing(item);
  assert.equal(draft.photo.source, item.scanPhoto.dataUrl);
  assert.equal(draft.photo.id, item.scanPhoto.id);
  assert.equal(
    draft.inventoryItem.product.title,
    "Bulbasaur · Base Set · #44/102 · EN · NM · Standard",
  );
  assert.equal(draft.offer.pricingSummary.price.value, "12.00");
  assert.throws(
    () => buildEbayListing({ ...item, scanPhoto: null }),
    /saved scan/,
  );
  assert.throws(
    () =>
      buildEbayListing({
        ...item,
        identity: { ...item.identity, setName: "x".repeat(100) },
      }),
    /80-character/,
  );
});
test("device identities are first-party and mutations reject other origins or missing cookies", () => {
  const headers = {};
  const res = { setHeader: (key, value) => (headers[key] = value) };
  const id = device({ headers: {} }, res);
  assert.equal(id.length, 64);
  assert.match(headers["Set-Cookie"], /HttpOnly; SameSite=Lax/);
  assert.throws(
    () =>
      guard(
        { method: "POST", headers: { "content-type": "application/json" } },
        res,
        ["POST"],
      ),
    /inventory first/,
  );
  assert.throws(
    () =>
      guard(
        {
          method: "POST",
          headers: {
            host: "cardrails.vercel.app",
            origin: "https://other.test",
            "content-type": "application/json",
          },
        },
        res,
        ["POST"],
      ),
    /Origin refused/,
  );
});

test("convergence clears targets; origin notifications preserve undelivered Card Rails changes", () => {
  const workspace = { ...emptyWorkspace(), items: [stock()], links };
  mutateInventory(workspace, {
    action: "adjust",
    id: "cr_1",
    delta: -1,
    idempotencyKey: "minus",
  });
  assert.equal(workspace.outbox.length, 4);
  mutateInventory(workspace, {
    action: "adjust",
    id: "cr_1",
    delta: 1,
    idempotencyKey: "plus",
  });
  assert.equal(workspace.outbox.length, 0);
  mutateInventory(workspace, {
    action: "adjust",
    id: "cr_1",
    delta: -1,
    idempotencyKey: "again",
  });
  recordSale(workspace, {
    itemId: "cr_1",
    channel: "cardtrader",
    quantity: 1,
    orderRef: "CT",
    lineId: "1",
  });
  const pending = workspace.outbox.find((i) => i.platform === "cardtrader");
  assert.equal(pending.targetQuantity, 3);
  assert.match(pending.idempotencyKey, /^again:/);
  assert.equal(
    workspace.events
      .find((e) => e.cause === "cardtrader_sale")
      .intents.find((i) => i.platform === "cardtrader").write,
    false,
  );
});
