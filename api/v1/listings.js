import {
  apiError,
  device,
  guard,
  readWorkspace,
  publicWorkspace,
} from "../../server/workspace.js";
import { ebayPayload, publishListing } from "../../server/listings.js";
export const maxDuration = 300;
export default async function handler(req, res) {
  try {
    guard(req, res, ["POST"]);
    const id = device(req, res);
    if (req.body.action === "preview") {
      const { workspace } = await readWorkspace(id),
        item = workspace.items.find((i) => i.id === req.body.itemId);
      if (!item)
        throw Object.assign(new Error("Card not found."), { status: 404 });
      const preview = ebayPayload(item, {
        ...req.body.settings,
        marketplaceId: workspace.links.ebay.marketplace,
      });
      return res
        .status(200)
        .json({
          title: preview.inventoryItem.product.title,
          exactTitle: preview.exactTitle,
          photo: item.scanPhoto,
          quantity: item.quantity,
          price: preview.offer.pricingSummary.price,
          offer: preview.offer,
          connected: workspace.links.ebay.status === "connected",
        });
    }
    if (!req.body.idempotencyKey)
      throw Object.assign(new Error("A publication key is required."), {
        status: 400,
      });
    const workspace = await publishListing(id, req.body);
    res.status(200).json(publicWorkspace(workspace));
  } catch (error) {
    apiError(res, error);
  }
}
