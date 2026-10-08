import {
  device,
  rawDeviceToken,
  setDeviceCookie,
  guard,
  apiError,
  readWorkspace,
  publicWorkspace,
} from "../../server/workspace.js";
import {
  createCapture,
  pairCapture,
  requestCode,
  approveCode,
  pollCode,
} from "../../server/capture.js";
export default async function handler(req, res) {
  try {
    guard(req, res, ["POST"]);
    if (req.body?.action === "pair") {
      setDeviceCookie(res, await pairCapture(req.body));
      return res.status(200).json({ paired: true });
    }
    const workspaceId = device(req, res);
    if (req.body?.action === "request-code")
      return res.status(200).json(await requestCode(req.body.code));
    if (req.body?.action === "poll-code") {
      const owner = await pollCode(req.body);
      if (owner) setDeviceCookie(res, owner);
      return res.status(200).json({ paired: Boolean(owner) });
    }
    if (req.body?.action === "approve-code") {
      await approveCode(req.body.id, workspaceId);
      return res
        .status(200)
        .json(publicWorkspace((await readWorkspace(workspaceId)).workspace));
    }
    const token = rawDeviceToken(req);
    const origin = process.env.VERCEL
      ? "https://cardrails.vercel.app"
      : req.headers.origin || `http://${req.headers.host}`;
    res.status(200).json(await createCapture(token, origin));
  } catch (error) {
    apiError(res, error);
  }
}
