import {
  apiError,
  device,
  guard,
  publicWorkspace,
  readWorkspace,
  transact,
} from "../../server/workspace.js";
import { savePhoto } from "../../server/photos.js";
import { runSync, credentialsFor } from "../../server/channels.js";
import { cardTrader, channelError } from "../../server/channelAdapters.js";
import { createItem, mutateInventory } from "../../server/inventory.js";

export const maxDuration = 300;
export default async function handler(req, res) {
  try {
    guard(req, res, ["GET", "POST"]);
    const id = device(req, res);
    let savedPhoto = null;
    if (
      req.method === "POST" &&
      ["create", "stage-scan"].includes(req.body?.action)
    ) {
      const validated = createItem(req.body.item || {}, []);
      savedPhoto = await savePhoto(id, validated.scanPhoto);
    }
    if (
      req.method === "POST" &&
      req.body?.action === "listing" &&
      req.body.channel === "cardtrader"
    ) {
      const state = (await readWorkspace(id)).workspace,
        credential = credentialsFor(state, "cardtrader"),
        item = state.items.find((i) => i.id === req.body.id);
      const products = await cardTrader(credential.token).exportProducts(
        item?.identity.cardtraderBlueprintId || undefined,
      );
      const product = products.find(
        (p) => String(p.id) === String(req.body.externalId),
      );
      if (!product)
        throw channelError(
          "This CardTrader listing was not found in your seller export.",
          400,
        );
      req.body.confirmedQuantity = product.quantity;
    }
    let workspace =
      req.method === "GET"
        ? (await readWorkspace(id)).workspace
        : await transact(id, (workspace) =>
            mutateInventory(workspace, req.body || {}, savedPhoto),
          );
    if (
      req.method === "POST" &&
      ["adjust", "listing"].includes(req.body.action) &&
      Object.values(workspace.links).some((l) => l.status === "connected")
    ) {
      try {
        workspace = await runSync(id);
      } catch (error) {
        workspace = (await readWorkspace(id)).workspace;
        workspace.syncError = error.message;
      }
    }
    res.status(200).json(publicWorkspace(workspace));
  } catch (error) {
    apiError(res, error);
  }
}
