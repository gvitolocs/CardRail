import {
  apiError,
  device,
  guard,
  publicWorkspace,
  transact,
} from "../../server/workspace.js";
import { runSync } from "../../server/channels.js";
import { recordSale } from "../../server/inventory.js";

export const maxDuration = 300;
export default async function handler(req, res) {
  try {
    guard(req, res, ["POST"]);
    const id = device(req, res);
    let workspace = await transact(id, (workspace) =>
      recordSale(workspace, req.body || {}),
    );
    if (
      Object.values(workspace.links).some((link) => link.status === "connected")
    ) {
      try {
        workspace = await runSync(id);
      } catch (error) {
        workspace.syncError = error.message;
      }
    }
    res.status(200).json(publicWorkspace(workspace));
  } catch (error) {
    apiError(res, error);
  }
}
