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
    position: item.location?.position ?? null,
    sequence: order.sequence,
    lineIndex,
  }
}

export function buildPickRun(orders, items, number) {
  const arrival = []

  for (const order of orders) {
    order.lines.forEach((line, lineIndex) => {
      const resolved = lineFor(order, line, lineIndex, items)
      if (resolved) arrival.push(resolved)
    })
  }

  const lines = sortPickLines(arrival, 'location')

  return {
    number,
    lines,
    arrival,
    stops: lines.map((line) => line.position),
  }
}

/** PowerTools picking columns we can apply to a sold line. Location is the default. */
export const PICK_SORTS = [
  { id: 'location', label: 'Location' },
  { id: 'name', label: 'English name' },
  { id: 'expansion', label: 'Expansion' },
  { id: 'condition', label: 'Condition' },
  { id: 'price', label: 'Price' },
]

export function sortPickLines(lines, mode = 'location') {
  const copy = lines.slice()
  copy.sort((a, b) => comparePick(a, b, mode))
  return copy
}

function comparePick(a, b, mode) {
  if (mode === 'name') return a.item.identity.name.localeCompare(b.item.identity.name)
  if (mode === 'expansion') return a.item.identity.setName.localeCompare(b.item.identity.setName)
  if (mode === 'condition') return a.item.condition.localeCompare(b.item.condition)
  if (mode === 'price') return b.item.price - a.item.price
  const box = (a.item.location?.verified === false ? "" : a.item.location?.box || "").localeCompare(b.item.location?.verified === false ? "" : b.item.location?.box || "")
  if (box) return box
  const row = (a.item.location?.row || "").localeCompare(b.item.location?.row || "", undefined, { numeric: true })
  if (row) return row
  return a.position - b.position
}
