import { unseal, seal } from "./credentials.js";
import { credentialsFor } from "./channels.js";
import { transact } from "./workspace.js";
import { channelError } from "./channelAdapters.js";
export async function ebayCredentials(id, workspace, fetcher = fetch) {
  const credential = credentialsFor(workspace, "ebay");
  if (!credential.expiresAt || credential.expiresAt > Date.now() + 60000)
    return credential;
  const app = workspace.credentials?.ebayApp
    ? unseal(workspace.credentials.ebayApp)
    : {
        clientId: process.env.EBAY_CLIENT_ID,
        clientSecret: process.env.EBAY_CLIENT_SECRET,
      };
  if (!credential.refreshToken || !app.clientId || !app.clientSecret)
    throw channelError(
      "Your eBay access token expired. Reconnect your seller account.",
      401,
    );
  const response = await fetcher(
    `${credential.sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"}/identity/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token)
    throw channelError(
      "eBay authorization expired or was revoked. Reconnect your account.",
      401,
    );
  const next = {
    ...credential,
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
  await transact(id, (latest) => {
    if (latest.credentials?.ebay && latest.links.ebay?.status === "connected")
      latest.credentials.ebay = seal(next);
    return latest;
  });
  return next;
}
