import { apiError, readWorkspace } from "../../server/workspace.js";
import { credentialsFor, runSync } from "../../server/channels.js";
import { verifyCardTraderSignature } from "../../server/webhooks.js";
export const maxDuration = 300;
export const config = { api: { bodyParser: false } };
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST")
      throw Object.assign(new Error("Method not allowed."), { status: 405 });
    const id = String(req.query.workspace || "");
    if (!/^[a-f0-9]{64}$/.test(id))
      throw Object.assign(new Error("Webhook refused."), { status: 403 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1000000)
        throw Object.assign(new Error("Webhook too large."), { status: 413 });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks),
      { workspace } = await readWorkspace(id),
      credential = credentialsFor(workspace, "cardtrader");
    if (
      !verifyCardTraderSignature(
        raw,
        req.headers.signature,
        credential.sharedSecret,
      )
    )
      throw Object.assign(new Error("Webhook signature refused."), {
        status: 403,
      });
    // Retrieve seller orders using the verified grant. Payload cannot spoof a sale.
    await runSync(id);
    res.status(200).json({ received: true });
  } catch (error) {
    if (error.status === 409) error.status = 503;
    apiError(res, error);
  }
}
