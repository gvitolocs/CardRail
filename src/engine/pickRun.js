/** Walk the shelf once. Marketplace order is not pick order. */

function lineFor(order, line, lineIndex, items) {
  const item = items.find((entry) =>
    entry.listings.some(
      (listing) =>
        listing.platform === order.platform && listing.externalId === line.externalId,
    ),
  )
  if (!item) return null
  return {
    key: `${order.id}:${line.externalId}`,
    orderId: order.id,
    orderRef: order.ref,
    platform: order.platform,
    quantity: line.quantity,
    item,
    position: item.location.position,
    sequence: order.sequence,
    lineIndex,
  }
}

export function buildPickRun(orders, items, number = 184) {
  const arrival = []

  for (const order of orders) {
    order.lines.forEach((line, lineIndex) => {
      const resolved = lineFor(order, line, lineIndex, items)
      if (resolved) arrival.push(resolved)
    })
  }

  const lines = arrival.slice().sort((a, b) => a.position - b.position)

  return {
    number,
    lines,
    arrival,
    stops: lines.map((line) => line.position),
  }
}
