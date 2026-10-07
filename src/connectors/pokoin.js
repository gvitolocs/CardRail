/**
 * Pokoin adapter.
 * Pokoin stays a client of CardRail: this file is the whole plugin surface.
 */

export function fromPokoinListing(raw) {
  return {
    platform: 'pokoin',
    externalId: raw.marketplace_user_listing_id,
    quantity: raw.qty,
    price: raw.price_cents / 100,
    identity: {
      game: raw.game,
      name: raw.card_name,
      setName: raw.set_label,
      number: raw.collector_number,
    },
    language: raw.lang.toUpperCase(),
    condition: raw.condition_code.toUpperCase(),
    printing: raw.finish,
  }
}
