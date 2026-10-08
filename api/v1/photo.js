import {
  apiError,
  device,
  guard,
  readWorkspace,
} from "../../server/workspace.js";
import { readPhoto } from "../../server/photos.js";
export default async function handler(req, res) {
  try {
    guard(req, res, ["GET"]);
    const deviceId = device(req, res);
    const sha256 = req.query.id;
    const { workspace } = await readWorkspace(deviceId);
    if (
      ![...workspace.items, ...(workspace.scanQueue || [])].some(
        (item) => item.scanPhoto?.sha256 === sha256,
      )
    )
      throw Object.assign(new Error("Photo not found."), { status: 404 });
    const bytes = await readPhoto(deviceId, sha256);
    res.setHeader("Content-Type", "image/jpeg");
    res.status(200).end(bytes);
  } catch (error) {
    apiError(res, error);
  }
}
