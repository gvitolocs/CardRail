/**
 * Pokoin adapter.
 * Pokoin stays a client of Card Rails: this file is the whole plugin surface.
 */

export function fromPokoinOrders(rawOrders) {
  return rawOrders.map((raw, sequence) => ({
    id: `pk-${raw.id}`,
    ref: raw.code,
    platform: 'pokoin',
    buyer: raw.buyer,
    placedAt: raw.placed_at,
    sequence,
    lines: raw.order_items.map((item) => ({
      externalId: String(item.listing_id),
      quantity: item.quantity,
      label: item.name,
    })),
  }))
}

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
