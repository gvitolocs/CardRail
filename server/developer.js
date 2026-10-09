import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { get, put } from '@vercel/blob';
import { readWorkspace, transact } from './workspace.js';

export const API_SCOPES = ['inventory:read', 'book:read'];
export const API_RESOURCES = [
  { resource: 'inventory', scope: 'inventory:read', description: 'Saved cards, quantities, variants, prices and physical locations. Filter by purpose=sale or collection, game, location or q.' },
  { resource: 'locations', scope: 'inventory:read', description: 'Storage locations and occupied ranges from your saved inventory.' },
  { resource: 'book', scope: 'book:read', description: 'Your recorded sales, order references, quantities and shelf codes.' },
  { resource: 'me', scope: null, description: 'Permissions and expiry of the current API key.' },
];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = token => createHash('sha256').update(token).digest('hex');
export function keyMetadata(key) {
  const { id, name, prefix, scopes, createdAt, expiresAt, revokedAt, lastUsedAt, requestCount } = key;
  return { id, name, prefix, scopes, createdAt, expiresAt, revokedAt, lastUsedAt, requestCount };
}
export function validKey(key, now) {
  return key && !key.revokedAt && (!key.expiresAt || Date.parse(key.expiresAt) > now);
}
export function pageOptions(query = {}) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('Use limit=1..100 and a non-negative integer offset.');
  if (query.purpose && !['sale', 'collection'].includes(query.purpose)) fail('Purpose must be sale or collection.');
  return { limit, offset };
}
function inventoryRow(item) {
  // Explicit projection: never expose credentials, queue, pairing grants or outbox.
  return {
    id: item.id, identity: item.identity, language: item.language, condition: item.condition,
    printing: item.printing, firstEdition: Boolean(item.firstEdition), signed: Boolean(item.signed), altered: Boolean(item.altered),
    quantity: item.quantity, price: item.price, currency: item.currency,
    purpose: item.purpose || 'sale', location: item.location?.verified === false ? null : item.location || null, art: item.art || null,
    source: item.source, hasScanPhoto: Boolean(item.scanPhoto), version: item.version,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}
export function readResource(workspace, key, resource, query = {}) {
  const spec = API_RESOURCES.find(entry => entry.resource === resource);
  if (!spec) fail('Unknown API resource.', 404);
  if (spec.scope && !key.scopes.includes(spec.scope)) fail(`This key requires ${spec.scope}.`, 403);
  if (resource === 'me') return { key: keyMetadata(key) };
  const { limit, offset } = pageOptions(query);
  let rows;
  if (resource === 'inventory') {
    const q = String(query.q || '').toLowerCase();
    rows = workspace.items.filter(item =>
      (!query.purpose || (item.purpose || 'sale') === query.purpose) &&
      (!query.game || item.identity.game === query.game) &&
      (!query.location || item.location?.box === query.location) &&
      (!q || [item.identity.name, item.identity.setName, item.identity.number].join(' ').toLowerCase().includes(q))
    ).map(inventoryRow);
  } else if (resource === 'book') {
    rows = workspace.book.map(({ id, at, itemId, name, channel, orderRef, lineId, delta, location, oversell }) => ({ id, at, itemId, name, channel, orderRef, lineId, delta, location, oversell }));
  } else {
    const locations = new Map();
    for (const item of workspace.items) {
      if (!item.location?.box || item.location.verified === false) continue;
      const box = item.location.box;
      const entry = locations.get(box) || { name: box, cardCount: 0, ranges: [] };
      entry.cardCount += item.quantity;
      const end = Math.max(item.location.end || 0, item.location.position + Math.max(1, item.quantity) - 1);
      entry.ranges.push({ itemId: item.id, start: item.location.position, end, row: item.location.row, stackSize: item.location.stackSize || null });
      locations.set(box, entry);
    }
    rows = [...locations.values()].sort((a,b) => a.name.localeCompare(b.name));
  }
  return { data: rows.slice(offset, offset + limit), pagination: { total: rows.length, limit, offset, nextOffset: offset + limit < rows.length ? offset + limit : null }, revision: workspace.revision, savedAt: workspace.savedAt || null };
}
async function readIndex(digest) {
  const blob = await get(`api-keys/${digest}.json`, { access: 'private', useCache: false });
  return blob ? JSON.parse(await new Response(blob.stream).text()) : null;
}
async function writeIndex(digest, value) {
  await put(`api-keys/${digest}.json`, JSON.stringify(value), { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' });
}
export function createDeveloperService(store = { readWorkspace, transact, readIndex, writeIndex }, now = () => Date.now()) {
  return {
    async list(owner) {
      const { workspace } = await store.readWorkspace(owner);
      return { keys: (workspace.apiKeys || []).map(keyMetadata), scopes: API_SCOPES, resources: API_RESOURCES };
    },
    async create(owner, input) {
      const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
      if (!name) fail('Give this API key a name.');
      if (!Array.isArray(input.scopes)) fail("Select valid read-only permissions.");
      const scopes = [...new Set(input.scopes)];
      if (!scopes.length || scopes.some(scope => !API_SCOPES.includes(scope))) fail('Select valid read-only permissions.');
      if (![30, 90, 365, null].includes(input.expiresInDays)) fail('Choose 30, 90, 365 days or no expiry.');
      const secret = `cr_read_${randomBytes(32).toString('hex')}`;
      const key = { id: randomUUID(), name, hash: hash(secret), prefix: secret.slice(0, 16) + '…' + secret.slice(-4), scopes, createdAt: new Date(now()).toISOString(), expiresAt: input.expiresInDays === null ? null : new Date(now() + input.expiresInDays * 86400000).toISOString(), revokedAt: null, lastUsedAt: null, requestCount: 0 };
      // An orphaned index cannot authorize anything until the workspace commit succeeds.
      await store.writeIndex(key.hash, { workspaceId: owner, keyId: key.id });
      await store.transact(owner, workspace => {
        workspace.apiKeys ||= [];
        if (workspace.apiKeys.filter(k => validKey(k, now())).length >= 10) fail('Revoke an active key before creating another (maximum 10).');
        workspace.apiKeys = [...workspace.apiKeys.slice(-99), key];
        return workspace;
      });
      return { key: keyMetadata(key), secret };
    },
    async revoke(owner, id) {
      await store.transact(owner, workspace => {
        const key = workspace.apiKeys?.find(k => k.id === id);
        if (!key) fail('API key not found.', 404);
        key.revokedAt ||= new Date(now()).toISOString();
        return workspace;
      });
      return this.list(owner);
    },
    async read(token, resource, query) {
      if (!/^cr_read_[a-f0-9]{64}$/.test(token || '')) fail('A valid Bearer API key is required.', 401);
      const digest = hash(token), index = await store.readIndex(digest);
      if (!index) fail('API key is invalid or revoked.', 401);
      let result;
      await store.transact(index.workspaceId, workspace => {
        const key = workspace.apiKeys?.find(k => k.id === index.keyId && k.hash === digest);
        if (!validKey(key, now())) fail('API key is invalid, expired or revoked.', 401);
        result = readResource(workspace, key, resource, query);
        key.lastUsedAt = new Date(now()).toISOString();
        key.requestCount++;
        return workspace;
      });
      return result;
    },
  };
}
export const developer = createDeveloperService();
