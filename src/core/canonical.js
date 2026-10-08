/** Channel-neutral values owned by Card Rails. */

const PLATFORMS = {
  cardtrader: "CardTrader",
  pokoin: "Pokoin",
  cardmarket: "Cardmarket",
  ebay: "eBay",
  rail: "Card Rails",
};

export function locationLabel(location) {
  if (!location || location.verified === false) return "Location needs confirmation";
  return `Box ${location.box} → Row ${location.row} → position ${location.position}`;
}

export function locationCode(location) {
  if (!location || location.verified === false) return "";
  return `B${location.box}-R${location.row}-${location.position}`;
}

export function eur(amount) {
  return `€${Number(amount || 0).toFixed(2)}`;
}

export function platformLabel(platform) {
  return PLATFORMS[platform] || platform;
}

export function gameLabel(game) {
  switch (game) {
    case "pokemon":
      return "Pokémon";
    case "magic":
      return "Magic";
    case "onepiece":
      return "One Piece";
    case "lorcana":
      return "Lorcana";
    default:
      return game;
  }
}

export function listingTitle(item, maxLength = 80) {
  const parts = [
    item.identity?.name,
    item.identity?.setName,
    item.identity?.number ? `#${item.identity.number}` : "",
    item.language,
    item.condition,
    item.printing,
    item.firstEdition ? "1st Ed." : "",
    item.signed ? "Signed" : "",
    item.altered ? "Altered" : "",
  ].filter(Boolean);
  const exact = parts.join(" · ").replace(/\s+/g, " ").trim();
  if (exact.length > maxLength)
    throw new Error("Precise listing title exceeds the channel limit.");
  return exact;
}

export function displayPhoto(item) {
  return item.scanPhoto?.dataUrl || item.scanPhoto?.url || item.art || "";
}

