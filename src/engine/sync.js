/**
 * Card Rails is the stock book. This engine emits channel-neutral intents;
 * authenticated adapters decide which documented remote endpoint executes them.
 */

function hash(value) {
  let result = 2166136261
  for (const character of String(value)) {
    result ^= character.charCodeAt(0)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function eventId(key) {
  return `sync_${hash(key)}`
}

function isLinked(platform, links = {}) {
  if (platform === 'cardmarket') {
    return Boolean(
      links.pokoin?.status === 'connected' &&
      links.cardmarket?.status === 'connected' &&
      links.cardmarket?.linkedVia === 'pokoin-account-link',
    )
  }
  return links[platform]?.status === 'connected'
}

function stockMode(listing) {
  if (listing.stockMode) return listing.stockMode
  return listing.platform === 'cardtrader' ? 'delta' : 'absolute'
}

function syncListing(listing, targetQuantity, meta, links) {
  const current = Number(listing.lastSyncedQuantity ?? listing.quantity ?? 0)
  const delta = targetQuantity - current

  if (listing.platform === meta.origin && (!meta.externalId || String(listing.externalId) === String(meta.externalId))) {
    const observed = Number.isSafeInteger(meta.observedQuantity) ? meta.observedQuantity : null
    return {
      listing: { ...listing, ...(observed !== null ? { quantity:observed,lastSyncedQuantity:observed,lastSyncedAt:new Date().toISOString() } : {}), syncStatus:observed !== null ? 'observed' : 'stale', requiresRead:observed === null },
      intent: { platform:listing.platform, action:meta.kind === 'restock' ? 'observe_cancel' : 'observe_sale', listingId:listing.externalId,targetQuantity,delta:meta.requestedDelta,write:false,reason:'Already applied on the origin channel; read to confirm quantity' },
    }
  }

  if ((listing.status || 'live') === 'inactive') {
    return {
      listing: {...listing,syncStatus:'stale'},
      intent: {
        platform: listing.platform,
        action: 'skip',
        listingId: listing.externalId,
        targetQuantity,
        delta: 0,
        write: false,
        reason: 'listing inactive',
      },
    }
  }

  if (!isLinked(listing.platform, links)) {
    return {
      listing: {...listing,syncStatus:'stale'},
      intent: {
        platform: listing.platform,
        action: 'skip',
        listingId: listing.externalId,
        targetQuantity,
        delta,
        write: false,
        reason: listing.platform === 'cardmarket' ? 'Pokoin–Cardmarket link not active' : 'channel not linked',
      },
    }
  }

  const mode = stockMode(listing)
  const action = mode === 'delta' ? 'increment_stock' : 'set_stock'
  return {
    listing: {
      ...listing,
      desiredQuantity: targetQuantity,
      syncStatus: delta === 0 ? 'current' : 'queued',
      requiresRead: true,
    },
    intent: {
      platform: listing.platform,
      action,
      listingId: listing.externalId,
      mode,
      targetQuantity,
      delta,
      write: delta !== 0,
      idempotencyKey: `${meta.key}:${listing.platform}:${listing.externalId}:${targetQuantity}`,
    },
  }
}

function apply(item, requestedDelta, meta, { links = {}, seenKeys = [] } = {}) {
  if (!Number.isSafeInteger(requestedDelta)) throw new Error('Stock delta must be a whole number.')
  if (!item || !requestedDelta) return { item, event: null, ledgerRow: null }
  if (seenKeys.includes(meta.key)) {
    return {
      item,
      event: {
        id: eventId(meta.key),
        key: meta.key,
        at: new Date().toISOString(),
        cause: meta.cause,
        origin: meta.origin,
        delta: 0,
        duplicate: true,
        intents: [],
        pushes: [],
      },
      ledgerRow: null,
    }
  }

  const before = Number(item.quantity || 0)
  const targetQuantity = Math.max(0, before + requestedDelta)
  const appliedDelta = targetQuantity - before
  const oversell = Math.max(0, Math.abs(requestedDelta) - Math.abs(appliedDelta))
  if (!appliedDelta && meta.kind !== 'sale') return { item, event: null, ledgerRow: null }

  const order = ['pokoin', 'cardmarket', 'cardtrader', 'ebay']
  const synced = [...(item.listings || [])].sort((a,b) => order.indexOf(a.platform) - order.indexOf(b.platform)).map((listing) => syncListing(listing, targetQuantity, { ...meta, requestedDelta }, links))
  const intents = synced.map((entry) => entry.intent)
  const at = new Date().toISOString()
  const event = {
    id: eventId(meta.key),
    key: meta.key,
    at,
    cause: meta.cause,
    kind: meta.kind,
    origin: meta.origin,
    orderRef: meta.orderRef || '',
    name: item.identity.name,
    itemId: item.id,
    requestedDelta,
    delta: appliedDelta,
    oversell,
    quantity: targetQuantity,
    intents,
    pushes: intents,
  }

  return {
    item: {
      ...item,
      quantity: targetQuantity,
      version: Number(item.version || 0) + 1,
      updatedAt: at,
      listings: synced.map((entry) => entry.listing),
    },
    event,
    ledgerRow: meta.kind === 'sale'
      ? {
          id: event.id,
          key: meta.key,
          at,
          name: item.identity.name,
          itemId: item.id,
          location: meta.location || '',
          delta: appliedDelta,
          requestedDelta,
          oversell,
          channel: meta.origin,
          orderRef: meta.orderRef || '',
        }
      : null,
  }
}

export function syncAdjust(item, delta, options = {}) {
  const key = options.idempotencyKey || `adjust:${item?.id}:${Date.now()}:${delta}`
  return apply(item, delta, {
    key,
    kind: 'adjust',
    cause: 'rail_adjust',
    origin: 'rail',
  }, options)
}

export function syncSale(item, { platform, quantity = 1, orderRef = '', lineId = '', idempotencyKey = '', externalId, observedQuantity }, options = {}) {
  const key = idempotencyKey || `${platform}:${orderRef || 'manual'}:${lineId || item?.id}`
  return apply(item, -Math.abs(quantity), {
    key,
    kind: 'sale',
    cause: `${platform}_sale`,
    origin: platform,
    orderRef,
    externalId, observedQuantity,
    location: options.location,
  }, options)
}

export function syncRestock(item, { platform, quantity = 1, orderRef = '', idempotencyKey = '' }, options = {}) {
  const key = idempotencyKey || `restock:${platform}:${orderRef || item?.id}:${quantity}`
  return apply(item, Math.abs(quantity), {
    key,
    kind: 'restock',
    cause: 'sale_cancelled',
    origin: platform,
    orderRef,
  }, options)
}

/** A channel export can change listing presence, never Card Rails stock. */
export function syncReconcile(items, { presentIds = [], complete = false, confirmEmpty = false }) {
  const at = new Date().toISOString()
  if (!complete) {
    const event = {
      id: eventId(`reconcile:incomplete:${at}`),
      at,
      cause: 'reconcile',
      skipped: true,
      reason: 'incomplete export',
      delta: 0,
      intents: [],
      pushes: [],
    }
    return { items, event }
  }

  const known = items.flatMap((item) => (item.listings || []).filter((listing) => listing.platform === 'cardtrader'))
  if (known.length > 0 && presentIds.length === 0 && !confirmEmpty) {
    const event = {
      id: eventId(`reconcile:suspicious-empty:${at}`),
      at,
      cause: 'reconcile',
      skipped: true,
      reason: 'empty complete export requires confirmation',
      delta: 0,
      intents: [],
      pushes: [],
    }
    return { items, event }
  }

  const present = new Set(presentIds.map(String))
  const intents = []
  const nextItems = items.map((item) => ({
    ...item,
    listings: (item.listings || []).map((listing) => {
      if (listing.platform !== 'cardtrader') return listing
      const exists = present.has(String(listing.externalId))
      const nextStatus = exists ? (listing.quantity === 0 ? 'sold_out' : 'live') : 'inactive'
      if ((listing.status || 'live') === nextStatus) return listing
      intents.push({
        platform: 'cardtrader',
        action: exists ? 'restore_listing' : 'mark_listing_inactive',
        listingId: listing.externalId,
        write: false,
        reason: exists ? 'present in complete export' : 'absent from complete export; no stock mutation',
      })
      return { ...listing, status: nextStatus, syncStatus: exists ? 'current' : 'stale' }
    }),
  }))

  const event = {
    id: eventId(`reconcile:${[...present].sort().join(',')}:${at}`),
    at,
    cause: 'reconcile',
    skipped: false,
    reason: intents.length ? 'listing presence updated from complete export' : 'export matches Card Rails',
    delta: 0,
    intents,
    pushes: intents,
  }
  return { items: nextItems, event }
}
