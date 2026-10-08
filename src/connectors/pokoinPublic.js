const PUBLIC_SEARCH = "https://api.pokoin.com/api/marketplace-search-page";

/** Public catalog search only. No seller token or Authorization header is accepted. */
export async function searchPokoinCatalog(
  query,
  { game = "pokemon", limit = 20, signal } = {},
) {
  const url = new URL(PUBLIC_SEARCH);
  url.searchParams.set("includeFacets", "0");
  url.searchParams.set("q", String(query || "").trim());
  url.searchParams.set("game", game);
  url.searchParams.set("limit", String(Math.min(100, Math.max(1, limit))));
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error || `Public Pokoin catalog failed (${response.status}).`,
    );
  return Array.isArray(data.cards) ? data.cards : [];
}
