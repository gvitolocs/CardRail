const CT = "https://api.cardtrader.com/api/v2";
export function channelError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}
async function json(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      payload.errors?.[0]?.message ||
      (Array.isArray(payload.errors)
        ? payload.errors.filter((e) => typeof e === "string").join(", ")
        : "");
    throw channelError(
      `${label} ${response.status === 401 || response.status === 403 ? "authorization was refused. Reconnect your seller account." : `request failed (${response.status})${detail ? ": " + detail : "."}`}`,
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  return payload;
}
export function cardTrader(token, fetcher = fetch) {
  async function request(path, body, method) {
    const response = await fetcher(CT + path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(
        path.startsWith("/products/export") ? 120000 : 20000,
      ),
    });
    return json(response, "CardTrader");
  }
  return {
    info: () => request("/info"),
    exportProducts: async (blueprint) => {
      const rows = await request(
        "/products/export" +
          (blueprint ? `?blueprint_id=${encodeURIComponent(blueprint)}` : ""),
      );
      if (!Array.isArray(rows))
        throw channelError(
          "CardTrader export is incomplete. Stock was preserved.",
        );
      return rows;
    },
    orders: async (from, page = 1) => {
      const rows = await request(
        `/orders?order_as=seller&sort=id.asc&limit=100&page=${page}&from=${encodeURIComponent(from)}`,
      );
      if (!Array.isArray(rows))
        throw channelError("CardTrader order export is incomplete.");
      return rows;
    },
    increment: async (id, delta) => {
      if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(delta))
        throw channelError("Invalid CardTrader stock change.", 400);
      const result = await request(`/products/${id}/increment`, {
        delta_quantity: delta,
      });
      if (result.result !== "ok")
        throw channelError("CardTrader did not confirm the stock change.");
      return result.resource;
    },
    create: async (item) => {
      if (!/^\d+$/.test(item.identity.cardtraderBlueprintId || ""))
        throw channelError("Match a CardTrader blueprint before listing.", 400);
      if (
        !item.cardtraderProperties ||
        !item.cardtraderProperties.condition ||
        !Object.keys(item.cardtraderProperties).some((key) =>
          key.endsWith("language"),
        )
      )
        throw channelError(
          "Confirm the blueprint’s condition, language and finish properties before creating a CardTrader listing.",
          400,
        );
      const result = await request("/products", {
        blueprint_id: Number(item.identity.cardtraderBlueprintId),
        quantity: item.quantity,
        price: item.price,
        error_mode: "strict",
        user_data_field: item.id,
        description: [
          item.identity.name,
          item.language,
          item.condition,
          item.printing,
        ].join(" · "),
        properties: item.cardtraderProperties || {
          condition: {
            M: "Mint",
            NM: "Near Mint",
            SP: "Slightly Played",
            MP: "Moderately Played",
            PL: "Played",
            PO: "Poor",
          }[item.condition],
        },
      });
      if (result.result !== "ok" || !result.resource?.id)
        throw channelError("CardTrader did not confirm creation.");
      return result.resource;
    },
    registerWebhook: (url) => request("/app", { webhook_url: url }, "PATCH"),
  };
}
export function ebay(token, { sandbox = false, fetcher = fetch } = {}) {
  const base = sandbox
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
  const media = sandbox
    ? "https://apim.sandbox.ebay.com"
    : "https://apim.ebay.com";
  async function request(path, body, method = "GET") {
    const response = await fetcher(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Language": "en-US",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 204) return {};
    return json(response, "eBay");
  }
  return {
    request,
    settings: async (marketplace) => {
      const [locations, payment, fulfillment, returns] = await Promise.all([
        request("/sell/inventory/v1/location?limit=100"),
        request(
          `/sell/account/v1/payment_policy?marketplace_id=${marketplace}`,
        ),
        request(
          `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplace}`,
        ),
        request(`/sell/account/v1/return_policy?marketplace_id=${marketplace}`),
      ]);
      return {
        locations: locations.locations || [],
        paymentPolicies: payment.paymentPolicies || [],
        fulfillmentPolicies: fulfillment.fulfillmentPolicies || [],
        returnPolicies: returns.returnPolicies || [],
      };
    },
    uploadPhoto: async (bytes) => {
      const form = new FormData();
      form.append(
        "image",
        new Blob([bytes], { type: "image/jpeg" }),
        "scan.jpg",
      );
      const response = await fetcher(
        media + "/commerce/media/v1_beta/image/create_image_from_file",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
          signal: AbortSignal.timeout(30000),
        },
      );
      const result = await json(response, "eBay photo upload");
      let imageUrl = result.imageUrl;
      const imageId = response.headers.get("location")?.split("/").pop();
      if (!imageUrl && imageId) {
        const detail = await fetcher(
          media +
            `/commerce/media/v1_beta/image/${encodeURIComponent(imageId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(20000),
          },
        );
        imageUrl = (await json(detail, "eBay photo retrieval")).imageUrl;
      }
      if (!/^https:\/\//.test(imageUrl || ""))
        throw channelError("eBay did not return the uploaded photo URL.");
      return { imageUrl, imageId, expiresAt: result.expirationDate };
    },
    inventory: (sku, payload) =>
      request(
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        payload,
        "PUT",
      ),
    existingOffers: (sku) =>
      request(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`),
    createOffer: (payload) =>
      request("/sell/inventory/v1/offer", payload, "POST"),
    updateOffer: (id, payload) =>
      request(
        `/sell/inventory/v1/offer/${encodeURIComponent(id)}`,
        payload,
        "PUT",
      ),
    getOffer: (id) =>
      request(`/sell/inventory/v1/offer/${encodeURIComponent(id)}`),
    publish: (id) =>
      request(
        `/sell/inventory/v1/offer/${encodeURIComponent(id)}/publish`,
        {},
        "POST",
      ),
    stock: async (sku, offerId, quantity) =>
      request(
        "/sell/inventory/v1/bulk_update_price_quantity",
        {
          requests: [
            {
              sku,
              shipToLocationAvailability: { quantity },
              offers: [{ offerId, availableQuantity: quantity }],
            },
          ],
        },
        "POST",
      ),
    orders: async (from) => {
      const orders = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const result = await request(
          `/sell/fulfillment/v1/order?limit=100&offset=${offset}&filter=${encodeURIComponent(`creationdate:[${from}..]`)}`,
        );
        orders.push(...(result.orders || []));
        if (!result.next) break;
      }
      return { orders };
    },
  };
}

/** Only a configured Card Rails-scoped Pokoin connector can accept this grant.
 * Never fall back to Pokoin session, Firebase or private seller APIs. */
export function pokoinChannel(grant, fetcher = fetch) {
  const origin = process.env.POKOIN_CARDRAILS_CONNECTOR_URL;
  if (!origin)
    throw channelError(
      "Pokoin has no Card Rails channel connector configured. Its public catalog and scanner remain available.",
      503,
    );
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    !/(^|\.)pokoin\.com$/.test(url.hostname) ||
    !url.pathname.startsWith("/api/cardrails/")
  )
    throw channelError("Pokoin connector configuration was refused.", 503);
  async function request(action, body = {}) {
    const response = await fetcher(origin, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${grant}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...body }),
      signal: AbortSignal.timeout(20000),
    });
    return json(response, "Pokoin channel");
  }
  return {
    connect: () => request("connect"),
    stock: (body) => request("stock", body),
    sales: (cursor) => request("sales", { cursor }),
    list: (body) => request("list", body),
  };
}
