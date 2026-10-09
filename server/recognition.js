const CATALOGS = {
  pokemon: "pokemon_western",
  magic: "magic_all",
  onepiece: "one_piece_english",
  lorcana: "lorcana_all",
};
export async function identifyPhoto(
  dataUrl,
  { game = "pokemon", language = "EN", fetcher = fetch } = {},
) {
  if (
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl || "") ||
    dataUrl.length > 2800000
  )
    throw Object.assign(new Error("Choose a card photo under 2 MB."), {
      status: 400,
    });
  const catalog =
    game === "pokemon"
      ? language === "JP"
        ? "pokemon_japanese"
        : language === "ZH"
          ? "pokemon_chinese"
          : "pokemon_western"
      : CATALOGS[game];
  if (!catalog)
    throw Object.assign(
      new Error(
        "This game has no recognition catalog yet. Use catalog search.",
      ),
      { status: 400 },
    );
  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from(dataUrl.split(",")[1], "base64")], {
      type: "image/jpeg",
    }),
    "card.jpg",
  );
  const response = await fetcher(
    `https://api.pokoin.com/api/scan/identify?catalog=${catalog}&top_k=5`,
    { method: "POST", body: form, signal: AbortSignal.timeout(25000) },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok)
    throw Object.assign(
      new Error(
        "Recognition is unavailable. Try another photo or use catalog search.",
      ),
      { status: 502 },
    );
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
