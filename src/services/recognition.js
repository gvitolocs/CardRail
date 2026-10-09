import { request } from "./api.js";
const CATALOGS = {
  pokemon: "pokemon_western",
  magic: "magic_all",
  onepiece: "one_piece_english",
  lorcana: "lorcana_all",
};
export function recognitionCatalog(game, language) {
  return game === "pokemon"
    ? language === "JP"
      ? "pokemon_japanese"
      : language === "ZH"
        ? "pokemon_chinese"
        : "pokemon_western"
    : CATALOGS[game];
}
export function recognitionMatches(data, game) {
  return {
    hits: (data.hits || []).map((hit) => ({
      name: hit.name,
      setName: hit.set,
      number: hit.collector_number,
      game,
      publicId: String(hit.public_id || hit.id),
      cardtraderBlueprintId: String(hit.ct_id || ""),
      art: hit.image_url,
      score: hit.score,
    })),
    multipleCards: (data.cards || []).length > 1,
  };
}
export async function recognizePublicPhoto(photo, { game, language }) {
  const catalog = recognitionCatalog(game, language);
  if (!catalog)
    throw new Error(
      "This game has no recognition catalog yet. Use catalog search.",
    );
  const blob = await (await fetch(photo.dataUrl)).blob();
  const form = new FormData();
  form.append("file", blob, "card.jpg");
  const url = `https://api.pokoin.com/api/scan/identify?catalog=${catalog}&top_k=5`;
  const send = () =>
    fetch(url, {
      method: "POST",
      body: form,
      credentials: "omit",
      signal: AbortSignal.timeout(25000),
    });
  let response;
  try {
    response = await send();
  } catch {
    try {
      response = await send();
    } catch {
      return request("recognize", { dataUrl: photo.dataUrl, game, language });
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok)
    throw new Error(
      "Recognition is unavailable. Try another photo or use catalog search.",
    );
  return recognitionMatches(data, game);
}
