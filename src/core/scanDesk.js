export const SCAN_DEFAULTS = {
  game: "pokemon",
  language: "EN",
  condition: "NM",
  printing: "Standard",
  firstEdition: false,
  signed: false,
  altered: false,
  storageLabel: "",
  stackSize: null,
  stack: 1,
  startPosition: 1,
  mergeRepeats: true,
  paused: false,
};
export const SCAN_LANGUAGES = [
  "EN",
  "IT",
  "JP",
  "ZH",
  "DE",
  "FR",
  "ES",
  "PT",
  "KO",
];
export const SCAN_CONDITIONS = ["NM", "SP", "MP", "PL", "PO"];
export const SCAN_FINISHES = ["Standard", "Holo", "Reverse Holo"];
export const SCAN_GAMES = {
  pokemon: "Pokémon",
  magic: "Magic",
  onepiece: "One Piece",
  lorcana: "Lorcana",
};
export function sameScanVariant(a, b) {
  return (
    ["game", "name", "setName", "number"].every(
      (key) => a.identity[key] === b.identity[key],
    ) &&
    [
      "language",
      "condition",
      "printing",
      "firstEdition",
      "signed",
      "altered",
      "storageLabel",
    ].every((key) => (a[key] ?? false) === (b[key] ?? false))
  );
}
// A blank location stays blank until the seller configures their physical storage.
export function normalizeScanSettings(workspace) {
  const settings = { ...SCAN_DEFAULTS, ...workspace.scanSettings };
  if (settings.locationConfigured !== true && settings.storageLabel === "05" && settings.stackSize === 80) {
    settings.storageLabel = "";
    settings.stackSize = null;
    for (const row of workspace.scanQueue || []) {
      if (row.storageLabel === "05" && row.stackSize === 80) {
        row.storageLabel = "";
        row.stackSize = null;
        row.location = null;
      }
    }
  }
  // Preserve old records, but never present the former automatic shelf as verified.
  for (const item of workspace.items || []) {
    if (["scan", "catalog"].includes(item.source) && item.location?.box === "05" && item.location.position >= 2100 && item.location.verified === undefined) item.location.verified = false;
  }
  workspace.scanSettings = settings;
  return workspace;
}
export function allocateScanLocations(items, rows) {
  const occupied = new Map();
  for (const item of items) {
    if (!item.location?.box || item.location.verified === false) continue;
    const end = Math.max(item.location.end || 0, item.location.position + Math.max(1, item.quantity) - 1);
    occupied.set(item.location.box, Math.max(occupied.get(item.location.box) || 0, end));
  }
  return rows.map((row) => {
    const box = row.storageLabel?.trim();
    const size = row.stackSize;
    if (!box || !Number.isSafeInteger(size) || size < 1) return { ...row, location: null };
    const requested = ((row.stack || 1) - 1) * size + (row.startPosition || 1);
    const position = Math.max(1, requested, (occupied.get(box) || 0) + 1);
    const end = position + Math.max(1, Number(row.quantity) || 1) - 1;
    occupied.set(box, end);
    return { ...row, location: { box, row: String(1 + Math.floor((position - 1) / size)), position, end, stackSize: size, verified: true } };
  });
}
export function scanSlotText(row) {
  if (!row.location) return "Set location and stack capacity";
  if (!row.location.stackSize) return `R${row.location.row} · ${row.location.position}`;
  const size = row.location.stackSize;
  const label = (position) => `${1 + Math.floor((position - 1) / size)}.${1 + ((position - 1) % size)}`;
  return `${label(row.location.position)}${row.quantity > 1 ? "–" + label(row.location.end) : ""}`;
}
