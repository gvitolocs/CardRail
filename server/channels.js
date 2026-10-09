import { randomUUID } from "node:crypto";
import { readWorkspace, transact } from "./workspace.js";
import { seal, unseal } from "./credentials.js";
import {
  cardTrader,
  ebay,
  pokoinChannel,
  channelError,
} from "./channelAdapters.js";
import { ebayCredentials } from "./ebayAuth.js";
import { recordSale } from "./inventory.js";

export async function connectChannel(id, input) {
  const channel = input.channel;
  if (!["cardtrader", "ebay", "pokoin"].includes(channel))
    throw channelError("Choose a supported connection.", 400);
  const token = String(input.token || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/[\r\n]/g, "");
  if (!token) throw channelError("Enter the channel API grant.", 400);
  let accountRef = "",
    name = "",
    extra = {};
  if (channel === "cardtrader") {
    const info = await cardTrader(token).info();
    if (!info.id)
      throw channelError("CardTrader could not identify this API application.");
    accountRef = String(info.user_id || info.id);
    name = info.name || "CardTrader";
    extra = {
      sharedSecret: info.shared_secret,
      webhookUrl: info.webhook_url || "",
    };
  } else if (channel === "ebay") {
    const marketplace = input.marketplace || "EBAY_IT";
    if (
      ![
        "EBAY_US",
        "EBAY_GB",
        "EBAY_DE",
        "EBAY_IT",
        "EBAY_FR",
        "EBAY_ES",
        "EBAY_AU",
      ].includes(marketplace)
    )
      throw channelError("Choose an eBay marketplace.", 400);
    await ebay(token, { sandbox: input.sandbox === true }).request(
      "/sell/inventory/v1/location?limit=1",
    );
    accountRef = "ebay-seller";
    name = input.sandbox ? "eBay Sandbox" : "eBay";
    extra = { sandbox: input.sandbox === true, marketplace };
  } else {
    const info = await pokoinChannel(token).connect();
    if (info.scope !== "cardrails:stock" || !info.accountRef)
      throw channelError("Pokoin did not verify a Card Rails stock grant.");
    accountRef = String(info.accountRef);
    name = info.accountName || "Pokoin";
    extra = { cardmarketLinked: info.cardmarketLinked === true };
  }
  return transact(id, (workspace) => {
    workspace.credentials ||= {};
    workspace.credentials[channel] = seal({ token, ...extra });
    workspace.links[channel] = {
      linked: true,
      status: "connected",
      accountRef,
      name,
      connectedAt:
        workspace.links[channel]?.accountRef === accountRef
          ? workspace.links[channel].connectedAt || new Date().toISOString()
          : new Date().toISOString(),
      ...(channel === "ebay"
        ? { marketplace: extra.marketplace, sandbox: extra.sandbox }
        : {}),
    };
    if (channel === "pokoin")
      workspace.links.cardmarket = {
        linked: extra.cardmarketLinked,
        status: extra.cardmarketLinked ? "connected" : "unlinked",
        linkedVia: extra.cardmarketLinked ? "pokoin-account-link" : null,
        accountRef,
      };
    for (const row of workspace.items)
      for (const listing of row.listings.filter(
        (l) => l.platform === channel && l.status !== "inactive",
      )) {
        if (
          !workspace.outbox.some(
            (i) => i.itemId === row.id && i.platform === channel,
          )
        )
          workspace.outbox.push({
            itemId: row.id,
            platform: channel,
            listingId: listing.externalId,
            targetQuantity: row.quantity,
            delta: row.quantity - listing.lastSyncedQuantity,
            write: true,
            mode: channel === "cardtrader" ? "delta" : "absolute",
            idempotencyKey: `connect:${randomUUID()}:${row.id}:${channel}`,
            status: "queued",
          });
      }
    for (const intent of workspace.outbox.filter(
      (i) => i.platform === channel,
    )) {
      intent.status = "queued";
      intent.reason = "";
    }
    return workspace;
  });
}
export async function disconnectChannel(id, channel) {
  return transact(id, (workspace) => {
    if (!["pokoin", "cardtrader", "cardmarket", "ebay"].includes(channel))
      throw channelError("Unknown channel.", 400);
    delete workspace.credentials?.[channel];
    workspace.links[channel] = {
      linked: false,
      status: "unlinked",
      linkedVia: null,
    };
    if (channel === "pokoin")
      workspace.links.cardmarket = {
        linked: false,
        status: "unlinked",
        linkedVia: null,
      };
    workspace.outbox = workspace.outbox.filter(
      (intent) => workspace.links[intent.platform]?.linked,
    );
    return workspace;
  });
}
export function credentialsFor(workspace, channel) {
  const credentials = workspace.credentials?.[channel];
  if (!credentials || workspace.links[channel]?.status !== "connected")
    throw channelError(
      `Connect ${channel === "ebay" ? "eBay" : channel === "cardtrader" ? "CardTrader" : "Pokoin"} in Platforms first.`,
      409,
    );
  return unseal(credentials);
}

export async function claimLease(
  id,
  store = { read: readWorkspace, transact },
) {
  const key = randomUUID();
  await store.transact(id, (workspace) => {
    if (workspace.syncLease?.expiresAt > Date.now())
      throw channelError(
        "A sync is already in progress. Stock is saved and will sync next.",
        409,
      );
    workspace.syncLease = { key, expiresAt: Date.now() + 300000 };
    return workspace;
  });
  return key;
}
export async function releaseLease(
  id,
  key,
  store = { read: readWorkspace, transact },
) {
  return store.transact(id, (workspace) => {
    if (workspace.syncLease?.key !== key) return null;
    delete workspace.syncLease;
    return workspace;
  });
}

async function observeCardTraderSales(id, workspace, client, store) {
  const from = (
    workspace.links.cardtrader.connectedAt || new Date().toISOString()
  ).slice(0, 10);
  for (let page = 1; page <= 10; page++) {
    const orders = await client.orders(from, page);
    for (const order of orders) {
      if (
        order.cancelled_at ||
        ["canceled", "request_for_cancel"].includes(order.state) ||
        !order.paid_at ||
        Date.parse(order.paid_at) <
          Date.parse(workspace.links.cardtrader.connectedAt)
      )
        continue;
      for (const line of order.order_items || []) {
        const externalId = String(
          line.product_id || line.product?.id || line.listing_id || "",
        );
        const current = (await store.read(id)).workspace;
        const item = current.items.find((row) =>
          row.listings.some(
            (listing) =>
              listing.platform === "cardtrader" &&
              listing.externalId === externalId,
          ),
        );
        if (!item) continue;
        const quantity = Number(line.quantity || 1);
        if (!Number.isSafeInteger(quantity) || quantity < 1) continue;
        await store.transact(id, (latest) =>
          recordSale(latest, {
            itemId: item.id,
            channel: "cardtrader",
            quantity,
            orderRef: String(order.code || order.id),
            lineId: String(line.id || externalId),
            externalId,
          }),
        );
      }
    }
    if (orders.length < 100) break;
  }
}
async function observeEbaySales(id, workspace, client, store) {
  const from = workspace.links.ebay.connectedAt || new Date().toISOString();
  const result = await client.orders(from);
  for (const order of result.orders || []) {
    if (
      order.orderPaymentStatus !== "PAID" ||
      order.cancelStatus?.cancelState === "CANCELED"
    )
      continue;
    for (const line of order.lineItems || []) {
      const item = workspace.items.find(
        (item) =>
          item.id === line.sku &&
          item.listings.some((listing) => listing.platform === "ebay"),
      );
      if (!item) continue;
      await store.transact(id, (latest) =>
        recordSale(latest, {
          itemId: item.id,
          channel: "ebay",
          quantity: Number(line.quantity),
          orderRef: order.orderId,
          lineId: line.lineItemId,
        }),
      );
    }
  }
}

export async function runSync(
  id,
  {
    fetcher = fetch,
    observeSales = true,
    store = { read: readWorkspace, transact },
  } = {},
) {
  const lease = await claimLease(id, store);
  try {
    let workspace = (await store.read(id)).workspace;
    const clients = {};
    for (const channel of ["cardtrader", "ebay", "pokoin"]) {
      if (workspace.links[channel]?.status !== "connected") continue;
      const credential =
        channel === "ebay"
          ? await ebayCredentials(id, workspace, fetcher)
          : credentialsFor(workspace, channel);
      clients[channel] =
        channel === "cardtrader"
          ? cardTrader(credential.token, fetcher)
          : channel === "ebay"
            ? ebay(credential.token, { sandbox: credential.sandbox, fetcher })
            : pokoinChannel(credential.token, fetcher);
    }
    if (observeSales) {
      // Pull sales before delivery so an origin sale can never be echoed back.
      if (clients.cardtrader)
        await observeCardTraderSales(id, workspace, clients.cardtrader, store);
      if (clients.ebay)
        await observeEbaySales(id, workspace, clients.ebay, store);
      if (clients.pokoin) {
        const data = await clients.pokoin.sales(
          workspace.links.pokoin.cursor || "",
        );
        for (const sale of data.sales || [])
          await store.transact(id, (latest) =>
            recordSale(latest, {
              ...sale,
              channel: sale.channel === "cardmarket" ? "cardmarket" : "pokoin",
            }),
          );
        if (data.cursor)
          await store.transact(id, (latest) => {
            latest.links.pokoin.cursor = data.cursor;
            return latest;
          });
      }
    }
    workspace = (await store.read(id)).workspace;
    const products = clients.cardtrader
      ? await clients.cardtrader.exportProducts()
      : null;
    if (products)
      await store.transact(id, (latest) => {
        for (const row of latest.items)
          for (const listing of row.listings.filter(
            (l) => l.platform === "cardtrader",
          )) {
            const product = products.find(
              (p) => String(p.id) === listing.externalId,
            );
            if (product && Number.isSafeInteger(product.quantity)) {
              listing.quantity = product.quantity;
              listing.lastSyncedQuantity = product.quantity;
              listing.lastSyncedAt = new Date().toISOString();
              listing.requiresRead = false;
              if (
                !latest.outbox.some(
                  (i) => i.itemId === row.id && i.platform === "cardtrader",
                )
              )
                listing.syncStatus =
                  product.quantity === row.quantity ? "synced" : "diverged";
            }
          }
        return latest;
      });
    const order = ["pokoin", "cardmarket", "cardtrader", "ebay"];
    const intents = workspace.outbox
      .slice()
      .sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
    const failedItems = new Set();
    for (const intent of intents) {
      if (failedItems.has(intent.itemId)) continue;
      workspace = (await store.read(id)).workspace;
      const currentIntent = workspace.outbox.find(
        (i) => i.idempotencyKey === intent.idempotencyKey,
      );
      const item = workspace.items.find((i) => i.id === intent.itemId);
      const listing = item?.listings.find(
        (l) =>
          l.platform === intent.platform && l.externalId === intent.listingId,
      );
      if (
        !currentIntent ||
        !listing ||
        !workspace.links[intent.platform]?.linked
      )
        continue;
      const client =
        intent.platform === "cardmarket"
          ? clients.pokoin
          : clients[intent.platform];
      if (!client) {
        failedItems.add(intent.itemId);
        continue;
      }
      let confirmed;
      try {
        if (intent.platform === "cardtrader") {
          const freshProducts = await client.exportProducts(
            item.identity.cardtraderBlueprintId || undefined,
          );
          const product = freshProducts.find(
            (product) => String(product.id) === listing.externalId,
          );
          if (!product)
            throw channelError(
              "The CardTrader listing is absent from the complete export. Stock was preserved; relist or reconnect it.",
              409,
            );
          const remote = Number(product.quantity);
          if (!Number.isSafeInteger(remote))
            throw channelError(
              "CardTrader returned an invalid stock quantity.",
            );
          // Read immediately before increment. Never replay a stale sale delta.
          const delta = item.quantity - remote;
          if (delta) {
            const result = await client.increment(listing.externalId, delta);
            confirmed = Number(result?.quantity);
            if (!Number.isSafeInteger(confirmed)) {
              const check = await client.exportProducts(
                item.identity.cardtraderBlueprintId || undefined,
              );
              confirmed = check.find(
                (p) => String(p.id) === listing.externalId,
              )?.quantity;
            }
            if (!Number.isSafeInteger(confirmed))
              throw channelError(
                "CardTrader stock confirmation was incomplete. Retry reads stock before making another change.",
              );
            product.quantity = confirmed;
          } else confirmed = remote;
        } else if (intent.platform === "ebay") {
          if (!listing.offerId)
            throw channelError(
              "Publish this eBay offer before synchronizing stock.",
              409,
            );
          const response = await client.stock(
            item.id,
            listing.offerId,
            item.quantity,
          );
          if (response.responses?.some((r) => r.statusCode >= 400))
            throw channelError("eBay refused a stock update.");
          confirmed = item.quantity;
        } else {
          const response = await client.stock({
            channel: intent.platform,
            listingId: listing.externalId,
            targetQuantity: item.quantity,
            idempotencyKey: intent.idempotencyKey,
          });
          if (
            response.confirmed !== true ||
            !Number.isSafeInteger(response.quantity)
          )
            throw channelError(
              "Pokoin channel did not confirm the stock update.",
            );
          confirmed = response.quantity;
        }
        await store.transact(id, (latest) => {
          const row = latest.items.find((i) => i.id === item.id),
            mirror = row.listings.find(
              (l) =>
                l.platform === intent.platform &&
                l.externalId === listing.externalId,
            );
          if (!mirror) return null;
          mirror.quantity = confirmed;
          mirror.lastSyncedQuantity = confirmed;
          mirror.lastSyncedAt = new Date().toISOString();
          delete mirror.syncError;
          mirror.syncStatus = row.quantity === confirmed ? "synced" : "queued";
          mirror.status = confirmed === 0 ? "sold_out" : "live";
          latest.outbox = latest.outbox.filter(
            (i) => i.idempotencyKey !== intent.idempotencyKey,
          );
          if (
            row.quantity !== confirmed &&
            !latest.outbox.some(
              (i) => i.itemId === row.id && i.platform === mirror.platform,
            )
          )
            latest.outbox.push({
              ...intent,
              targetQuantity: row.quantity,
              delta: row.quantity - confirmed,
              idempotencyKey: `${intent.idempotencyKey}:converge:${row.version}`,
              status: "queued",
            });
          return latest;
        });
      } catch (error) {
        // Stop subsequent channels for this card when an earlier channel failed.
        failedItems.add(intent.itemId);
        await store.transact(id, (latest) => {
          const queued = latest.outbox.find(
            (i) => i.idempotencyKey === intent.idempotencyKey,
          );
          if (queued) {
            queued.status = "error";
            queued.reason = error.message;
            queued.attempts = (queued.attempts || 0) + 1;
          }
          const mirror = latest.items
            .find((i) => i.id === intent.itemId)
            ?.listings.find((l) => l.platform === intent.platform);
          if (mirror) {
            mirror.syncStatus = "error";
            mirror.syncError = error.message;
          }
          return latest;
        });
      }
    }
    await store.transact(id, (latest) => {
      latest.lastSyncAt = new Date().toISOString();
      return latest;
    });
  } finally {
    await releaseLease(id, lease, store);
  }
  return (await store.read(id)).workspace;
}
