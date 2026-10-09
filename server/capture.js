import {
  randomBytes,
  randomInt,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { get, put, del } from "@vercel/blob";
import { transact } from "./workspace.js";
import { seal, unseal } from "./credentials.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function createCapture(token, origin) {
  const id = randomBytes(16).toString("hex"),
    secret = randomBytes(24).toString("hex"),
    code = String(randomInt(1000, 10000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  // A code locates a pairing request; only the owner can approve access.
  const codePath = `capture-codes/${code}.json`;
  const previous = await get(codePath, {
    access: "private",
    useCache: false,
    headers: { "Accept-Encoding": "identity" },
  });
  if (previous) {
    const record = JSON.parse(await new Response(previous.stream).text());
    if (record.expiresAt > Date.now()) return createCapture(token, origin);
    try {
      await del(previous.blob.url, { ifMatch: previous.blob.etag });
    } catch {
      return createCapture(token, origin);
    }
  }
  try {
    await put(codePath, JSON.stringify({ id, expiresAt }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  } catch (e) {
    if (/already exists|precondition/i.test(e.message))
      return createCapture(token, origin);
    throw e;
  }
  await put(
    `capture/${id}.json`,
    JSON.stringify({
      owner: seal(token),
      secretHash: hash(secret),
      codeHash: hash(code),
      expiresAt,
    }),
    { access: "private", addRandomSuffix: false },
  );
  return {
    id,
    secret,
    code,
    expiresAt,
    url: `${origin}/#capture=${id}&key=${secret}&code=${code}`,
  };
}
export async function pairCapture({ id, secret, code }) {
  if (
    !/^[a-f0-9]{32}$/.test(id || "") ||
    !/^[a-f0-9]{48}$/.test(secret || "") ||
    !/^\d{4}$/.test(code || "")
  )
    throw Object.assign(new Error("Invalid phone pairing link."), {
      status: 400,
    });
  const blob = await get(`capture/${id}.json`, {
    access: "private",
    useCache: false,
    headers: { "Accept-Encoding": "identity" },
  });
  if (!blob)
    throw Object.assign(
      new Error(
        "This pairing link has expired. Create a new one on your desk.",
      ),
      { status: 410 },
    );
  const data = JSON.parse(await new Response(blob.stream).text());
  if (
    data.expiresAt < Date.now() ||
    !timingSafeEqual(Buffer.from(data.secretHash), Buffer.from(hash(secret))) ||
    !timingSafeEqual(Buffer.from(data.codeHash), Buffer.from(hash(code)))
  )
    throw Object.assign(new Error("This pairing link is invalid or expired."), {
      status: 403,
    });
  try {
    await del(blob.blob.url, { ifMatch: blob.blob.etag });
  } catch {
    throw Object.assign(
      new Error("This link was already used. Create a new one."),
      { status: 410 },
    );
  }
  const owner = unseal(data.owner);
  await transact(hash(owner), (workspace) => {
    workspace.scanPhone = { pairedAt: new Date().toISOString(), captureId: id };
    return workspace;
  });
  await del(`capture-codes/${code}.json`).catch(() => {});
  return owner;
}

async function privateRecord(path) {
  const blob = await get(path, {
    access: "private",
    useCache: false,
    headers: { "Accept-Encoding": "identity" },
  });
  if (!blob)
    throw Object.assign(
      new Error("Pairing code or request expired. Generate a new code."),
      { status: 410 },
    );
  return {
    blob: blob.blob,
    data: JSON.parse(await new Response(blob.stream).text()),
  };
}
export async function requestCode(code) {
  if (!/^\d{4}$/.test(code || ""))
    throw Object.assign(new Error("Enter the four-digit code."), {
      status: 400,
    });
  const { data: index } = await privateRecord(`capture-codes/${code}.json`);
  const { data: capture } = await privateRecord(`capture/${index.id}.json`);
  if (capture.expiresAt < Date.now())
    throw Object.assign(new Error("Code expired. Generate a new code."), {
      status: 410,
    });
  const owner = unseal(capture.owner),
    id = randomBytes(16).toString("hex"),
    secret = randomBytes(24).toString("hex");
  const expiresAt = Math.min(capture.expiresAt, Date.now() + 120000);
  await transact(hash(owner), (workspace) => {
    if (workspace.scanPairRequest?.expiresAt > Date.now())
      throw Object.assign(
        new Error(
          "A phone request is already waiting. Confirm it on the desktop or wait two minutes.",
        ),
        { status: 429 },
      );
    workspace.scanPairRequest = { id, captureId: index.id, code, expiresAt };
    return workspace;
  });
  await put(
    `pair-requests/${id}.json`,
    JSON.stringify({
      owner: capture.owner,
      secretHash: hash(secret),
      captureId: index.id,
      code,
      expiresAt,
      status: "pending",
    }),
    { access: "private", addRandomSuffix: false },
  );
  return { id, secret, expiresAt, status: "pending" };
}
export async function approveCode(requestId, workspaceId) {
  if (!/^[a-f0-9]{32}$/.test(requestId || ""))
    throw Object.assign(new Error("Invalid phone request."), { status: 400 });
  const { data, blob } = await privateRecord(`pair-requests/${requestId}.json`);
  const owner = unseal(data.owner);
  if (hash(owner) !== workspaceId || data.expiresAt < Date.now())
    throw Object.assign(
      new Error("Phone request expired or belongs to another desk."),
      { status: 403 },
    );
  const capture = await privateRecord(`capture/${data.captureId}.json`);
  await del(capture.blob.url, { ifMatch: capture.blob.etag });
  await put(
    `pair-requests/${requestId}.json`,
    JSON.stringify({ ...data, status: "approved" }),
    { access: "private", addRandomSuffix: false, ifMatch: blob.etag },
  );
  await del(`capture-codes/${data.code}.json`).catch(() => {});
  await transact(workspaceId, (workspace) => {
    if (workspace.scanPairRequest?.id === requestId)
      workspace.scanPairRequest.status = "approved";
    return workspace;
  });
}
export async function pollCode({ id, secret }) {
  if (!/^[a-f0-9]{32}$/.test(id || "") || !/^[a-f0-9]{48}$/.test(secret || ""))
    throw Object.assign(new Error("Invalid phone request."), { status: 400 });
  const { data, blob } = await privateRecord(`pair-requests/${id}.json`);
  if (
    data.expiresAt < Date.now() ||
    !timingSafeEqual(Buffer.from(data.secretHash), Buffer.from(hash(secret)))
  )
    throw Object.assign(new Error("Phone request invalid or expired."), {
      status: 403,
    });
  if (data.status !== "approved") return null;
  await del(blob.url, { ifMatch: blob.etag });
  const owner = unseal(data.owner);
  await transact(hash(owner), (workspace) => {
    workspace.scanPairRequest = null;
    workspace.scanPhone = {
      pairedAt: new Date().toISOString(),
      captureId: data.captureId,
    };
    return workspace;
  });
  return owner;
}
