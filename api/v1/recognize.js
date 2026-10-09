import { guard, apiError } from "../../server/workspace.js";
import { identifyPhoto } from "../../server/recognition.js";
export default async function handler(req, res) {
  try {
    guard(req, res, ["POST"]);
    res
      .status(200)
      .json(
        await identifyPhoto(req.body?.dataUrl, {
          game: req.body?.game,
          language: req.body?.language,
        }),
      );
  } catch (error) {
    apiError(res, error);
  }
}
