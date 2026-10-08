import { createHash, randomBytes } from "node:crypto";
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { SCAN_DEFAULTS, normalizeScanSettings } from "../src/core/scanDesk.js";
import { DEFAULT_LINKS } from "../src/services/inventoryStore.js";

export function emptyWorkspace() {
  return {
    items: [],
    scanQueue: [],
    scanSettings: { ...SCAN_DEFAULTS },
    book: [],
    events: [],
    links: structuredClone(DEFAULT_LINKS),
    pickedKeys: [],
    outbox: [],
    revision: 0,
  };
}

export function device(req, res) {
  let token = /(?:^|;\s*)cardrails_device=([a-f0-9]{64})(?:;|$)/.exec(
    req.headers.cookie || "",
  )?.[1];
  if (!token) {
    token = randomBytes(32).toString("hex");
    setDeviceCookie(res, token);
  }
  return createHash("sha256").update(token).digest("hex");
}

export async function readWorkspace(id) {
  const blob = await get(`workspaces/${id}.json`, {
    access: "private",
    useCache: false,
    headers: { "Accept-Encoding": "identity" },
  });
  if (!blob) return { workspace: emptyWorkspace(), etag: null };
  return {
    workspace: normalizeScanSettings(JSON.parse(await new Response(blob.stream).text())),
    etag: blob.blob.etag,
  };
}

export async function transact(id, update) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { workspace, etag } = await readWorkspace(id);
    const next = update(workspace);
    if (!next) return workspace;
    next.revision = workspace.revision + 1;
    next.savedAt = new Date().toISOString();
    try {
      await put(`workspaces/${id}.json`, JSON.stringify(next), {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json",
        ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
      });
      return next;
    } catch (error) {
      if (
        !(error instanceof BlobPreconditionFailedError) &&
        !/already exists/i.test(error.message)
      )
        throw error;
    }
  }
  throw Object.assign(
    new Error("Inventory changed concurrently. Please retry."),
    { status: 409 },
  );
}

export function guard(req, res, methods) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.headers.authorization) throw Object.assign(new Error("API keys can only access the documented read-only developer endpoints."), { status: 403 });
  if (!methods.includes(req.method)) {
    res.setHeader("Allow", methods.join(", "));
    throw Object.assign(new Error("Method not allowed."), { status: 405 });
  }
  if (req.method !== "GET") {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host)
      throw Object.assign(new Error("Origin refused."), { status: 403 });
    if (
      !String(req.headers["content-type"] || "").startsWith("application/json")
    )
      throw Object.assign(new Error("JSON body required."), { status: 415 });
    if (!/cardrails_device=[a-f0-9]{64}/.test(req.headers.cookie || ""))
      throw Object.assign(new Error("Open the Card Rails inventory first."), {
        status: 401,
      });
  }
}

export function apiError(res, error) {
  const status = error.status || 503;
  res.status(status).json({
    error: error.status
      ? error.message
      : "Inventory storage is unavailable. Your change was not saved.",
  });
}

export function publicWorkspace(workspace) {
  const {
    apiKeys: _apiKeys,
    credentials: _credentials,
    oauth: _oauth,
    syncLease: _lease,
    ...safe
  } = workspace;
  return safe;
}
export function setDeviceCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `cardrails_device=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.VERCEL ? "; Secure" : ""}`,
  );
}
export function rawDeviceToken(req) {
  return /(?:^|;\s*)cardrails_device=([a-f0-9]{64})(?:;|$)/.exec(
    req.headers.cookie || "",
  )?.[1];
}
