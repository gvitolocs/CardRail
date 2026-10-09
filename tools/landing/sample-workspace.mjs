// Sample inventory for the landing-page screenshots, built with the app's own
// inventory engine (stage, commit to shelf positions, sell) instead of
// hand-written JSON. Nothing is written to Blob storage.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emptyWorkspace, publicWorkspace } from "../../server/workspace.js";
import { createItem, mutateInventory, recordSale } from "../../server/inventory.js";

const cards = fileURLToPath(new URL("../../public/cards/", import.meta.url));

const SAMPLE = [
  ["Charizard ex", "XY Black Star Promos", "XY121", "132187.jpg", "NM", "Holo", 48, 2],
  ["Umbreon", "BW Black Star Promos", "BW85", "111070.jpg", "NM", "Holo", 22],
  ["Gengar ex", "Phantom Forces", "114/119", "124693.jpg", "SP", "Holo", 35],
  ["Rayquaza", "EX Deoxys", "107/107", "115169.jpg", "NM", "Holo", 90, 2],
  ["Mew", "Pokémon Rumble", "Lv.39", "125922.jpg", "MP", "Standard", 6, 1, "JP"],
  ["Lugia GX", "Super-Burst Impact", "227/095", "143309.jpg", "NM", "Holo", 30, 1, "JP"],
  ["Gardevoir δ", "EX Delta Species", "5/113", "114908.jpg", "PL", "Holo", 14],
  ["Pikachu", "McDonald's 25th", "25", "152950.jpg", "NM", "Holo", 3, 3],
];

/** sha256 of each scan photo → the JPEG on disk, for the photo route mock. */
export const photoFiles = new Map();

export async function buildSampleWorkspace() {
  const workspace = emptyWorkspace();
  workspace.scanSettings = {
    ...workspace.scanSettings,
    storageLabel: "05",
    stackSize: 100,
    stack: 3,
    mergeRepeats: false,
  };
  SAMPLE.forEach(([name, setName, number, file, condition, printing, price, quantity = 1, language = "EN"], index) => {
    const path = cards + file;
    const item = {
      identity: { game: "pokemon", name, setName, number },
      art: `/cards/${file}`,
      quantity,
      price,
      language,
      condition,
      printing,
      scanPhoto: { dataUrl: `data:image/jpeg;base64,${readFileSync(path).toString("base64")}` },
    };
    // Same metadata savePhoto() returns after storing the bytes.
    const { dataUrl: _bytes, ...photo } = createItem(item, []).scanPhoto;
    photoFiles.set(photo.sha256, path);
    mutateInventory(
      workspace,
      // The desk stamps each scan with the batch defaults active at that moment.
      { action: "stage-scan", idempotencyKey: `sample-stage-${index}`, item, defaults: { language, condition, printing } },
      { ...photo, url: `/api/v1/photo?id=${photo.sha256}` },
    );
  });
  mutateInventory(workspace, {
    action: "commit-scans",
    idempotencyKey: "sample-commit",
    ids: workspace.scanQueue.slice(0, 6).map((row) => row.id),
    intent: "sale",
  });
  // Direct Card Rails sales: no marketplace connection is claimed.
  for (const [name, orderRef] of [["Charizard ex", "sample-1001"], ["Umbreon", "sample-1002"]]) {
    const item = workspace.items.find((row) => row.identity.name === name);
    recordSale(workspace, { itemId: item.id, channel: "rail", quantity: 1, orderRef, lineId: "1" });
  }
  workspace.scanPhone = { pairedAt: new Date().toISOString(), captureId: "0".repeat(32) };
  return publicWorkspace(workspace);
}
