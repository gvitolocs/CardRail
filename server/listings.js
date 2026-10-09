import { readWorkspace, transact } from "./workspace.js";
import { credentialsFor, claimLease, releaseLease } from "./channels.js";
import {
  ebay,
  cardTrader,
  pokoinChannel,
  channelError,
} from "./channelAdapters.js";
import { ebayCredentials } from "./ebayAuth.js";
import { readPhoto } from "./photos.js";
import { buildEbayListing } from "../src/connectors/ebay.js";

export function ebayPayload(item, settings = {}) {
  const draft = buildEbayListing(item, { title: settings.title });
  const conditions = {
    M: "400010",
    NM: "400010",
    SP: "400015",
    MP: "400016",
    PL: "400017",
    PO: "400017",
  };
  draft.inventoryItem.condition = "USED_VERY_GOOD";
  draft.inventoryItem.conditionDescriptors = [
    { name: "40001", values: [conditions[item.condition]] },
  ];
  draft.inventoryItem.product.aspects.Type = ["CCG Individual Cards"];
  draft.inventoryItem.product.aspects.Game = [
    {
      pokemon: "Pokémon",
      magic: "Magic: The Gathering",
      onepiece: "One Piece CCG",
      lorcana: "Disney Lorcana",
    }[item.identity.game] || item.identity.game,
  ];
  draft.inventoryItem.product.aspects.Language = [
    {
      EN: "English",
      IT: "Italian",
      JP: "Japanese",
      ZH: "Chinese",
      DE: "German",
      FR: "French",
      ES: "Spanish",
      PT: "Portuguese",
      KO: "Korean",
    }[item.language] || item.language,
  ];
  return {
    ...draft,
    offer: {
      ...draft.offer,
      categoryId: "183454",
      marketplaceId: settings.marketplaceId || "EBAY_IT",
      merchantLocationKey: settings.merchantLocationKey || "",
      listingDescription: draft.exactTitle,
      listingPolicies: {
        paymentPolicyId: settings.paymentPolicyId || "",
        fulfillmentPolicyId: settings.fulfillmentPolicyId || "",
        returnPolicyId: settings.returnPolicyId || "",
      },
    },
  };
}
export async function publishListing(
  id,
  { itemId, channel, settings = {}, idempotencyKey },
  {
    fetcher = fetch,
    store = { read: readWorkspace, transact },
    photoReader = readPhoto,
  } = {},
) {
  const lease = await claimLease(id, store);
  try {
    let workspace = (await store.read(id)).workspace;
    const item = workspace.items.find((i) => i.id === itemId);
    if (!item) throw channelError("Card not found.", 404);
    if (item.purpose === "collection" || !item.scanPhoto || item.quantity < 1)
      throw channelError(
        "A saved photo and available stock are required.",
        400,
      );
    const credential =
      channel === "ebay"
        ? await ebayCredentials(id, workspace, fetcher)
        : credentialsFor(
            workspace,
            channel === "cardmarket" ? "pokoin" : channel,
          );
    const existing = item.listings.find((l) => l.platform === channel);
    if (channel === "ebay" && existing?.status === "live") return workspace;
    if (
      existing?.publicationKey === idempotencyKey &&
      existing.status === "live"
    )
      return workspace;
    let listing;
    if (channel === "ebay") {
      const client = ebay(credential.token, {
        sandbox: credential.sandbox,
        fetcher,
      });
      const payload = ebayPayload(item, {
        ...settings,
        marketplaceId: workspace.links.ebay.marketplace,
      });
      if (
        !Object.values(payload.offer.listingPolicies).every(Boolean) ||
        !payload.offer.merchantLocationKey
      )
        throw channelError(
          "Choose payment, delivery, return policies and a shipping location.",
          400,
        );
      let media = item.scanPhoto.ebayMedia;
      if (
        !media?.imageUrl ||
        (media.expiresAt && Date.parse(media.expiresAt) < Date.now() + 3600000)
      ) {
        const bytes = await photoReader(id, item.scanPhoto.sha256);
        media = await client.uploadPhoto(bytes);
        await store.transact(id, (latest) => {
          const row = latest.items.find((i) => i.id === itemId);
          row.scanPhoto.ebayMedia = { ...media, sha256: row.scanPhoto.sha256 };
          return latest;
        });
      }
      payload.inventoryItem.product.imageUrls = [media.imageUrl];
      await client.inventory(item.id, payload.inventoryItem);
      let offerId = existing?.offerId;
      if (!offerId) {
        let offers = [];
        try {
          offers = (await client.existingOffers(item.id)).offers || [];
        } catch (error) {
          if (!/404/.test(error.message)) throw error;
        }
        const offer = offers.find(
          (offer) =>
            offer.marketplaceId === payload.offer.marketplaceId &&
            offer.format === "FIXED_PRICE",
        );
        offerId =
          offer?.offerId || (await client.createOffer(payload.offer)).offerId;
        if (!offerId) throw channelError("eBay did not return an offer ID.");
      }
      let remoteOffer = null;
      if (existing?.offerId) {
        remoteOffer = await client.getOffer(offerId);
        if (remoteOffer.status !== "PUBLISHED")
          await client.updateOffer(offerId, payload.offer);
      }
      // Persist offer ID before publishing, so retries cannot create another offer.
      await store.transact(id, (latest) => {
        const row = latest.items.find((i) => i.id === itemId);
        const prior = row.listings.find((l) => l.platform === "ebay");
        row.listings = [
          ...row.listings.filter((l) => l.platform !== "ebay"),
          {
            ...prior,
            platform: "ebay",
            externalId: prior?.externalId || `offer:${offerId}`,
            offerId,
            status: prior?.status || "draft",
            publicationKey: idempotencyKey,
            publishPayload: payload.offer,
            syncStatus: "publishing",
            quantity: item.quantity,
            lastSyncedQuantity: item.quantity,
          },
        ];
        return latest;
      });
      const result =
        remoteOffer?.status === "PUBLISHED" && remoteOffer.listing?.listingId
          ? { listingId: remoteOffer.listing.listingId }
          : await client.publish(offerId);
      if (!result.listingId)
        throw channelError(
          "eBay did not confirm publication. The saved offer can be retried.",
        );
      listing = {
        platform: "ebay",
        externalId: String(result.listingId),
        offerId,
        publicationKey: idempotencyKey,
        quantity: item.quantity,
        lastSyncedQuantity: item.quantity,
        status: "live",
        syncStatus: "synced",
        lastSyncedAt: new Date().toISOString(),
        url: `https://${credential.sandbox ? "www.sandbox.ebay.com" : "www.ebay.com"}/itm/${result.listingId}`,
        stockMode: "absolute",
      };
    } else if (channel === "cardtrader") {
      const client = cardTrader(credential.token, fetcher);
      if (existing?.status === "live")
        throw channelError(
          "This card already has a CardTrader listing. Use Sync stock to update it.",
          409,
        );
      // user_data_field is a deterministic reference for recovering timed-out creates.
      const products = await client.exportProducts(
        item.identity.cardtraderBlueprintId,
      );
      const previous = products.find(
        (product) => product.user_data_field === item.id,
      );
      const result =
        previous ||
        (await client.create({
          ...item,
          cardtraderProperties: settings.properties,
        }));
      listing = {
        platform: "cardtrader",
        externalId: String(result.id),
        quantity: result.quantity,
        lastSyncedQuantity: result.quantity,
        status: "live",
        syncStatus: "synced",
        stockMode: "delta",
        publicationKey: idempotencyKey,
        lastSyncedAt: new Date().toISOString(),
      };
    } else if (channel === "pokoin" || channel === "cardmarket") {
      if (
        channel === "cardmarket" &&
        workspace.links.cardmarket?.status !== "connected"
      )
        throw channelError(
          "Your Pokoin grant has no linked Cardmarket account.",
          409,
        );
      const result = await pokoinChannel(credential.token, fetcher).list({
        channel,
        item,
        idempotencyKey,
      });
      if (!result.listingId || result.confirmed !== true)
        throw channelError("Channel did not confirm the listing.");
      listing = {
        platform: channel,
        externalId: String(result.listingId),
        quantity: item.quantity,
        lastSyncedQuantity: item.quantity,
        status: "live",
        syncStatus: "synced",
        stockMode: result.stockMode || "absolute",
        publicationKey: idempotencyKey,
      };
    } else throw channelError("Unknown listing channel.", 400);
    return await store.transact(id, (latest) => {
      const row = latest.items.find((i) => i.id === itemId);
      row.listings = [
        ...row.listings.filter((l) => l.platform !== channel),
        listing,
      ];
      if (row.quantity !== listing.quantity) {
        listing.syncStatus = "queued";
        latest.outbox.push({
          platform: channel,
          itemId: row.id,
          listingId: listing.externalId,
          targetQuantity: row.quantity,
          delta: row.quantity - listing.quantity,
          write: true,
          mode: listing.stockMode,
          idempotencyKey: `${idempotencyKey}:converge:${row.version}`,
          status: "queued",
        });
      }
      latest.events.unshift({
        id: `listing_${idempotencyKey}`,
        key: `listing:${idempotencyKey}`,
        at: new Date().toISOString(),
        cause: "listing_published",
        itemId: row.id,
        name: row.identity.name,
        channel,
        delta: 0,
        intents: [],
      });
      return latest;
    });
  } finally {
    await releaseLease(id, lease, store);
  }
}
