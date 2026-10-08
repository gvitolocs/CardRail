import { searchPokoinCatalog } from "../../src/connectors/pokoinPublic.js";
export default async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed." });
  try {
    const cards = await searchPokoinCatalog(
      String(req.query.q || "").slice(0, 160),
      {
        game: String(req.query.game || "pokemon"),
        signal: AbortSignal.timeout(10000),
      },
    );
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(200).json({ cards });
  } catch {
    res
      .status(502)
      .json({
        error: "Public catalog unavailable. Enter the card details manually.",
      });
  }
}
