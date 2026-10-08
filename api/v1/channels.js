import {
  apiError,
  device,
  guard,
  readWorkspace,
  publicWorkspace,
  transact,
} from "../../server/workspace.js";
import {
  connectChannel,
  disconnectChannel,
  credentialsFor,
} from "../../server/channels.js";
import { ebayCredentials } from "../../server/ebayAuth.js";
import { cardTrader, ebay } from "../../server/channelAdapters.js";
export const maxDuration = 300;
export default async function handler(req, res) {
  try {
    guard(req, res, ["GET", "POST"]);
    const id = device(req, res);
    if (req.method === "GET") {
      const { workspace } = await readWorkspace(id);
      if (req.query.action === "ebay-settings") {
        const credential = await ebayCredentials(id, workspace);
        return res
          .status(200)
          .json(
            await ebay(credential.token, {
              sandbox: credential.sandbox,
            }).settings(workspace.links.ebay.marketplace),
          );
      }
      if (req.query.action === "cardtrader-products") {
        const credential = credentialsFor(workspace, "cardtrader");
        const products = await cardTrader(credential.token).exportProducts(
          req.query.blueprint,
        );
        return res
          .status(200)
          .json({
            products: products.map((p) => ({
              id: String(p.id),
              name: p.name_en || p.name,
              quantity: p.quantity,
              blueprintId: String(p.blueprint_id),
              properties: p.properties_hash || p.properties,
              price: p.price_cents / 100,
            })),
          });
      }
      return res
        .status(200)
        .json({
          links: workspace.links,
          ebayOAuthConfigured: Boolean(
            workspace.credentials?.ebayApp ||
              (process.env.EBAY_CLIENT_ID &&
                process.env.EBAY_CLIENT_SECRET &&
                process.env.EBAY_REDIRECT_URI),
          ),
          pokoinConnectorConfigured: Boolean(
            process.env.POKOIN_CARDRAILS_CONNECTOR_URL,
          ),
        });
    }
    if (req.body.action === "enable-cardtrader-webhook") {
      const state = (await readWorkspace(id)).workspace,
        credential = credentialsFor(state, "cardtrader");
      const url = `https://cardrails.vercel.app/api/v1/hooks?workspace=${id}`;
      const info = await cardTrader(credential.token).info();
      if (info.webhook_url && info.webhook_url !== url)
        throw Object.assign(
          new Error(
            "This CardTrader API application already has another webhook. Use a dedicated Card Rails API application.",
          ),
          { status: 409 },
        );
      await cardTrader(credential.token).registerWebhook(url);
      const updated = await transact(id, (latest) => {
        latest.links.cardtrader.webhookEnabled = true;
        return latest;
      });
      return res.status(200).json(publicWorkspace(updated));
    }
    const workspace =
      req.body.action === "disconnect"
        ? await disconnectChannel(id, req.body.channel)
        : await connectChannel(id, req.body);
    res.status(200).json(publicWorkspace(workspace));
  } catch (error) {
    apiError(res, error);
  }
}
