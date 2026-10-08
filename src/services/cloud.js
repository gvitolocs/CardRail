// Card Rails API (Rust + Postgres): the account shared with the iPhone and
// Android apps, the CardTrader import and the compact inventory.
import { decodeCompactRow } from '../core/codes.js'

export const CLOUD_API = import.meta.env.VITE_CARDRAILS_API || 'https://cardrails-api.pokoin.com'
const TOKEN_KEY = 'cardrails_cloud_token'

export const cloudToken = {
  get() {
    try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value)
      else localStorage.removeItem(TOKEN_KEY)
    } catch { /* private mode */ }
  },
}

export async function cloud(path, { method = 'GET', body } = {}) {
  const token = cloudToken.get()
  const response = await fetch(CLOUD_API + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (response.status === 401) cloudToken.set('')
  if (!response.ok) {
    const error = new Error(data.error || `Card Rails request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return data
}

export async function signIn(email, password, create = false) {
  const data = await cloud(create ? '/v1/auth/signup' : '/v1/auth/login', {
    method: 'POST',
    body: { email, password, client: 'web' },
  })
  cloudToken.set(data.token)
  return data
}

export async function signOut() {
  try { await cloud('/v1/auth/logout', { method: 'POST', body: {} }) } catch { /* already gone */ }
  cloudToken.set('')
}

// Catalog details by public id, one table per game (cards files are immutable).
const tables = new Map()
let catalogIndex = null

async function catalogTables(game) {
  if (tables.has(game)) return tables.get(game)
  const pending = (async () => {
    catalogIndex ??= fetch(`${CLOUD_API}/v1/catalogs/index.json`).then((r) => r.json())
    const index = await catalogIndex
    const merged = new Map()
    for (const entry of index.catalogs.filter((c) => c.game === game)) {
      const file = await fetch(`${CLOUD_API}/v1/catalogs/${entry.cards.path}`).then((r) => r.json())
      const at = (name) => file.fields.indexOf(name)
      const [id, name, number, set, image] = ['id', 'name', 'number', 'set', 'image'].map(at)
      for (const row of file.rows) {
        const key = String(row[id])
        if (!merged.has(key)) merged.set(key, { name: row[name] ?? '', number: row[number] ?? '', setName: row[set] ?? '', image: row[image] ?? '' })
      }
    }
    return merged
  })()
  tables.set(game, pending)
  pending.catch(() => tables.delete(game))
  return pending
}

/** Compact inventory → copies with names: blueprint details from the catalogs, extras for the rest. */
export async function loadCloudInventory() {
  const compact = await cloud('/v1/inventory/compact')
  const copies = compact.rows.map((row) => decodeCompactRow(row, compact.boxes))
  const games = [...new Set(copies.filter((c) => c.publicId).map((c) => c.game))]
  const byGame = new Map(await Promise.all(games.map(async (g) => [g, await catalogTables(g).catch(() => new Map())])))
  for (const copy of copies) {
    const card = copy.publicId ? byGame.get(copy.game)?.get(copy.publicId) : null
    copy.name ??= card?.name ?? ''
    copy.setName ??= card?.setName ?? ''
    copy.number ??= card?.number ?? ''
    copy.image = card?.image ?? ''
  }
  return { revision: compact.revision, boxes: compact.boxes, copies }
}
