import { get, put } from "@vercel/blob";

export async function savePhoto(deviceId, photo) {
  const { dataUrl, ...metadata } = photo;
  await put(
    `photos/${deviceId}/${photo.sha256}.jpg`,
    Buffer.from(dataUrl.split(",")[1], "base64"),
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/jpeg",
    },
  );
  return { ...metadata, url: `/api/v1/photo?id=${photo.sha256}` };
}
export async function readPhoto(deviceId, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || ""))
    throw Object.assign(new Error("Photo not found."), { status: 404 });
  const photo = await get(`photos/${deviceId}/${sha256}.jpg`, {
    access: "private",
    useCache: false,
  });
  if (!photo)
    throw Object.assign(new Error("Photo not found."), { status: 404 });
  return Buffer.from(await new Response(photo.stream).arrayBuffer());
}
