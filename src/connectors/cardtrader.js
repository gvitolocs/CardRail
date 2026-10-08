/**
 * CardTrader adapter.
 * Knows CardTrader order fields. Card Rails core never sees them.
 */

export function fromCardTraderOrders(rawOrders) {
  return rawOrders.map((raw, sequence) => ({
    id: `ct-${raw.id}`,
    ref: raw.code,
    platform: 'cardtrader',
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
