import {
  apiError,
  device,
  guard,
  readWorkspace,
} from "./workspace.js";
import { readPhoto } from "./photos.js";
import { buildEbayListing } from "../src/connectors/ebay.js";
export default async function handler(req, res) {
  try {
    guard(req, res, ["POST"]);
    const deviceId = device(req, res);
    const { workspace } = await readWorkspace(deviceId);
    const item = workspace.items.find((i) => i.id === req.body?.itemId);
    if (!item)
      throw Object.assign(new Error("Inventory row not found."), {
        status: 404,
      });
    const photoBytes =
      item.scanPhoto?.sha256 && !item.scanPhoto?.dataUrl
        ? await readPhoto(deviceId, item.scanPhoto.sha256)
        : null;
    const draftItem = photoBytes
      ? {
          ...item,
          scanPhoto: {
            ...item.scanPhoto,
            dataUrl: `data:image/jpeg;base64,${photoBytes.toString("base64")}`,
          },
        }
      : item;
    const draft = buildEbayListing(draftItem, { title: req.body?.title });
    res.status(200).json(draft);
  } catch (error) {
    apiError(res, Object.assign(error, { status: error.status || 400 }));
  }
}
