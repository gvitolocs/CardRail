import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { seal, unseal } from "../server/credentials.js";
import { emptyWorkspace, publicWorkspace } from "../server/workspace.js";
import { runSync } from "../server/channels.js";
import { publishListing } from "../server/listings.js";
import { recordSale } from "../server/inventory.js";
import { identifyPhoto } from "../server/recognition.js";
import { verifyCardTraderSignature } from "../server/webhooks.js";
process.env.CARDRAILS_ENCRYPTION_KEY = "ab".repeat(32);
function item() {
  return {
    id: "cr_test",
    identity: {
      game: "pokemon",
      name: "Bulbasaur",
      setName: "Base Set",
      number: "44/102",
      cardtraderBlueprintId: "100",
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
      id: "photo_same",
      sha256: "aa".repeat(32),
      url: "/api/v1/photo?id=same",
    },
    listings: [],
  };
}
function memory(workspace) {
  return {
    read: async () => ({ workspace: structuredClone(workspace) }),
    transact: async (_id, update) => {
      const result = update(structuredClone(workspace));
      if (result) {
        for (const key of Object.keys(workspace)) delete workspace[key];
        Object.assign(workspace, result);
      }
      return structuredClone(workspace);
    },
  };
}
function connected(channels = ["cardtrader"]) {
  const state = emptyWorkspace();
  state.items = [item()];
  state.credentials = {};
  for (const platform of channels) {
    state.links[platform] = {
      linked: true,
      status: "connected",
      marketplace: "EBAY_IT",
      connectedAt: "2026-10-07T00:00:00Z",
      linkedVia: platform === "cardmarket" ? "pokoin-account-link" : null,
    };
    state.credentials[platform] = seal({ token: "test-only", sandbox: false });
    state.items[0].listings.push({
      platform,
      externalId: platform === "cardtrader" ? "123" : platform,
      offerId: platform === "ebay" ? "offer_1" : undefined,
      quantity: 5,
      lastSyncedQuantity: 5,
      status: "live",
    });
  }
  return state;
}
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
test("credentials are encrypted, authenticated, and never returned to the browser", () => {
  const encrypted = seal({ token: "secret" });
  assert.equal(JSON.stringify(encrypted).includes("secret"), false);
  assert.deepEqual(unseal(encrypted), { token: "secret" });
  assert.throws(() =>
    unseal({ ...encrypted, tag: Buffer.alloc(16).toString("base64") }),
  );
  const safe = publicWorkspace({
    ...emptyWorkspace(),
    credentials: { ebay: encrypted },
    syncLease: { key: "lease" },
    oauth: { state: "hidden" },
  });
  assert.equal("credentials" in safe, false);
  assert.equal("syncLease" in safe, false);
});
test("recognition uploads a photo only to the public endpoint without bearer auth", async () => {
  const result = await identifyPhoto("data:image/jpeg;base64,/9j/AA==", {
    fetcher: async (url, options) => {
      assert.match(
        url,
        /^https:\/\/api.pokoin.com\/api\/scan\/identify\?catalog=pokemon_western/,
      );
      assert.equal(options.headers, undefined);
      assert.equal(options.body.get("file").type, "image/jpeg");
      return json({
        ok: true,
        hits: [
          {
            name: "Bulbasaur",
            set: "Base Set",
            collector_number: "44/102",
            ct_id: 100,
            public_id: 44,
            score: 0.99,
          },
        ],
      });
    },
  });
  assert.equal(result.hits[0].cardtraderBlueprintId, "100");
});
test("stock delivery recomputes CardTrader delta from a fresh export and never sends absolute quantity", async () => {
  const state = connected();
  recordSale(state, {
    itemId: "cr_test",
    channel: "rail",
    quantity: 1,
    orderRef: "A",
    lineId: "1",
  });
  const calls = [];
  let remote = 7;
  const fetcher = async (url, options) => {
    calls.push([url, options.method]);
    if (url.includes("/orders?")) return json([]);
    if (url.includes("/products/export"))
      return json([{ id: 123, quantity: remote }]);
    assert.match(url, /\/products\/123\/increment$/);
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { delta_quantity: -3 });
    remote = 4;
    return json({ result: "ok", resource: { id: 123, quantity: 4 } });
  };
  await runSync("id", { store: memory(state), fetcher });
  assert.equal(state.items[0].quantity, 4);
  assert.equal(state.items[0].listings[0].lastSyncedQuantity, 4);
  assert.equal(state.outbox.length, 0);
  assert.equal(calls.filter((c) => c[0].includes("increment")).length, 1);
});
test("CardTrader-origin orders are deduplicated and never echoed to its increment endpoint", async () => {
  const state = connected();
  const fetcher = async (url) => {
    if (url.includes("/orders?"))
      return json([
        {
          id: 10,
          paid_at: "2026-10-07T10:00:00Z",
          order_items: [{ id: 1, product_id: 123, quantity: 1 }],
        },
      ]);
    if (url.includes("/products/export"))
      return json([{ id: 123, quantity: 4 }]);
    throw new Error("Unexpected write " + url);
  };
  await runSync("id", { store: memory(state), fetcher });
  await runSync("id", { store: memory(state), fetcher });
  assert.equal(state.items[0].quantity, 4);
  assert.equal(state.book.length, 1);
  assert.equal(state.outbox.length, 0);
  assert.equal(state.items[0].listings[0].lastSyncedQuantity, 4);
});
test("malformed and absent exports preserve stock and pending delivery", async () => {
  const state = connected();
  recordSale(state, {
    itemId: "cr_test",
    channel: "rail",
    quantity: 1,
    orderRef: "A",
    lineId: "1",
  });
  await assert.rejects(
    () =>
      runSync("id", {
        observeSales: false,
        store: memory(state),
        fetcher: async () => json({ partial: true }),
      }),
    /incomplete/,
  );
  assert.equal(state.items[0].quantity, 4);
  assert.equal(state.outbox.length, 1);
  await runSync("id", {
    observeSales: false,
    store: memory(state),
    fetcher: async () => json([]),
  });
  assert.equal(state.items[0].quantity, 4);
  assert.equal(state.outbox[0].status, "error");
});
test("failed earlier channel blocks later delivery while preserving the stock book", async () => {
  process.env.POKOIN_CARDRAILS_CONNECTOR_URL =
    "https://pokoin.com/api/cardrails/channel";
  const state = connected(["pokoin", "cardmarket", "ebay"]);
  recordSale(state, {
    itemId: "cr_test",
    channel: "rail",
    quantity: 1,
    orderRef: "A",
    lineId: "1",
  });
  const calls = [];
  await runSync("id", {
    observeSales: false,
    store: memory(state),
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(JSON.parse(options.body).channel, "pokoin");
      return new Response("{}", { status: 500 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(state.items[0].quantity, 4);
  assert.equal(state.book.length, 1);
  assert.equal(state.outbox[0].status, "error");
  delete process.env.POKOIN_CARDRAILS_CONNECTOR_URL;
});
test("eBay publishes the exact stored photo bytes, title, variant and policy selections; retry creates no duplicate", async () => {
  const state = connected(["ebay"]);
  state.items[0].listings = [];
  const bytes = Buffer.from([255, 216, 255, 42]);
  const calls = [];
  const settings = {
    merchantLocationKey: "warehouse",
    paymentPolicyId: "payment",
    fulfillmentPolicyId: "delivery",
    returnPolicyId: "returns",
  };
  const fetcher = async (url, options) => {
    calls.push(url);
    if (url.includes("create_image_from_file")) {
      assert.deepEqual(
        Buffer.from(await options.body.get("image").arrayBuffer()),
        bytes,
      );
      return json({ imageUrl: "https://i.ebayimg.com/same.jpg" });
    }
    if (url.includes("/inventory_item/")) {
      const payload = JSON.parse(options.body);
      assert.equal(
        payload.product.title,
        "Bulbasaur · Base Set · #44/102 · EN · NM · Standard",
      );
      assert.deepEqual(payload.product.imageUrls, [
        "https://i.ebayimg.com/same.jpg",
      ]);
      assert.deepEqual(payload.conditionDescriptors, [
        { name: "40001", values: ["400010"] },
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/offer?")) return json({ offers: [] });
    if (url.endsWith("/offer")) {
      assert.equal(
        JSON.parse(options.body).listingPolicies.fulfillmentPolicyId,
        "delivery",
      );
      return json({ offerId: "offer1" });
    }
    if (url.endsWith("/publish")) return json({ listingId: "listing1" });
    throw new Error(url);
  };
  const options = {
    fetcher,
    store: memory(state),
    photoReader: async () => bytes,
  };
  await publishListing(
    "id",
    {
      itemId: "cr_test",
      channel: "ebay",
      settings,
      idempotencyKey: "publication1",
    },
    options,
  );
  const count = calls.length;
  await publishListing(
    "id",
    {
      itemId: "cr_test",
      channel: "ebay",
      settings,
      idempotencyKey: "publication1",
    },
    options,
  );
  assert.equal(calls.length, count);
  assert.equal(state.items[0].listings[0].externalId, "listing1");
  assert.equal(
    state.items[0].scanPhoto.ebayMedia.sha256,
    state.items[0].scanPhoto.sha256,
  );
});
test("CardTrader webhook authenticates raw bytes and rejects a changed body", () => {
  const raw = Buffer.from('{"id":123}'),
    secret = "test-shared-secret",
    signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyCardTraderSignature(raw, signature, secret), true);
  assert.equal(
    verifyCardTraderSignature(Buffer.from('{"id":124}'), signature, secret),
    false,
  );
  assert.equal(verifyCardTraderSignature(raw, "bogus", secret), false);
});

test('a browser network failure retries recognition through only the first-party public relay', async () => {
  const {recognizePublicPhoto}=await import('../src/services/recognition.js');
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async (url,options)=>{
    if(String(url).startsWith('data:'))return original(url,options);
    calls.push(String(url));
    if(String(url).startsWith('https://api.pokoin.com/api/scan/identify'))throw new TypeError('Network interrupted');
    assert.equal(url,'/api/v1/recognize');
    assert.equal(options.credentials,'same-origin');
    const body=JSON.parse(options.body);
    assert.equal(body.game,'pokemon');assert.equal(body.language,'EN');
    return json({hits:[{name:'Bulbasaur',cardtraderBlueprintId:'380362'}],multipleCards:false});
  };
  try {
    const result=await recognizePublicPhoto({dataUrl:'data:image/jpeg;base64,/9j/AA=='},{game:'pokemon',language:'EN'});
    assert.equal(result.hits[0].name,'Bulbasaur');assert.equal(calls.length,3);
  }finally{globalThis.fetch=original;}
});
