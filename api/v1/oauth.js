import { randomBytes, createHash } from "node:crypto";
import { get, put, del } from "@vercel/blob";
import {
  apiError,
  device,
  guard,
  transact,
  readWorkspace,
} from "../../server/workspace.js";
import { seal, unseal } from "../../server/credentials.js";
import { ebay, channelError } from "../../server/channelAdapters.js";
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];
export default async function handler(req, res) {
  try {
    guard(req, res, ["GET", "POST"]);
    const id = device(req, res);
    const app = {
      clientId: process.env.EBAY_CLIENT_ID,
      clientSecret: process.env.EBAY_CLIENT_SECRET,
      redirectUri: process.env.EBAY_REDIRECT_URI,
    };
    const workspace = (await readWorkspace(id)).workspace;
    const config = workspace.credentials?.ebayApp
      ? unseal(workspace.credentials.ebayApp)
      : app;
    if (req.method === "POST" && req.body.action === "configure") {
      const input = req.body;
      if (!input.clientId || !input.clientSecret || !input.redirectUri)
        throw channelError(
          "Enter the eBay application ID, secret and RuName.",
          400,
        );
      await transact(id, (latest) => {
        latest.credentials ||= {};
        latest.credentials.ebayApp = seal({
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          redirectUri: input.redirectUri,
          sandbox: input.sandbox === true,
        });
        return latest;
      });
      return res.status(200).json({ configured: true });
    }
    if (!config.clientId || !config.clientSecret || !config.redirectUri)
      throw channelError(
        "Set up your eBay application or connect using a seller access token.",
        409,
      );
    const sandbox = config.sandbox === true;
    if (req.method === "POST") {
      const state = randomBytes(32).toString("hex");
      await put(
        `oauth/${createHash("sha256").update(state).digest("hex")}.json`,
        JSON.stringify({ workspaceId: id, expiresAt: Date.now() + 600000 }),
        { access: "private", addRandomSuffix: false },
      );
      const url = new URL(
        sandbox
          ? "https://auth.sandbox.ebay.com/oauth2/authorize"
          : "https://auth.ebay.com/oauth2/authorize",
      );
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
      }).toString();
      return res.status(200).json({ url: url.toString() });
    }
    const state = String(req.query.state || "");
    if (!/^[a-f0-9]{64}$/.test(state))
      throw channelError("Invalid eBay authorization state.", 403);
    const blob = await get(
      `oauth/${createHash("sha256").update(state).digest("hex")}.json`,
      {
        access: "private",
        useCache: false,
        headers: { "Accept-Encoding": "identity" },
      },
    );
    if (!blob)
      throw channelError("eBay connection expired. Please try again.", 410);
    const data = JSON.parse(await new Response(blob.stream).text());
    if (data.workspaceId !== id || data.expiresAt < Date.now())
      throw channelError(
        "eBay authorization did not match this Card Rails account.",
        403,
      );
    await del(blob.blob.url, { ifMatch: blob.blob.etag });
    const response = await fetch(
      `${sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"}/identity/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(req.query.code || ""),
          redirect_uri: config.redirectUri,
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    const result = await response.json();
    if (!response.ok || !result.access_token)
      throw channelError(
        "eBay refused the seller authorization. Try connecting again.",
        401,
      );
    await ebay(result.access_token, { sandbox }).request(
      "/sell/inventory/v1/location?limit=1",
    );
    await transact(id, (latest) => {
      latest.credentials ||= {};
      latest.credentials.ebay = seal({
        token: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + result.expires_in * 1000,
        sandbox,
      });
      latest.links.ebay = {
        linked: true,
        status: "connected",
        name: sandbox ? "eBay Sandbox" : "eBay",
        accountRef: "ebay-seller",
        marketplace: "EBAY_IT",
        sandbox,
        connectedAt: new Date().toISOString(),
      };
      return latest;
    });
    res.statusCode = 302;
    res.setHeader("Location", "https://cardrails.vercel.app/#platforms");
    res.end();
  } catch (error) {
    apiError(res, error);
  }
}
