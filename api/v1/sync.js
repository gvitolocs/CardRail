import {
  guard,
  device,
  apiError,
  publicWorkspace,
} from "../../server/workspace.js";
import { runSync } from "../../server/channels.js";
export const maxDuration = 300;
export default async function handler(req, res) {
  try {
    guard(req, res, ["POST"]);
    res.status(200).json(publicWorkspace(await runSync(device(req, res))));
  } catch (error) {
    apiError(res, error);
  }
}
