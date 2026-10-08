import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function key() {
  const value = process.env.CARDRAILS_ENCRYPTION_KEY;
  if (!/^[a-f0-9]{64}$/i.test(value || ""))
    throw Object.assign(
      new Error("Channel credential storage is not configured."),
      { status: 503 },
    );
  return Buffer.from(value, "hex");
}
export function seal(value) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const content = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    content: content.toString("base64"),
  };
}
export function unseal(value) {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(value.iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.content, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  );
}
