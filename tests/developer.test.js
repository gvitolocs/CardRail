import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeveloperService, readResource } from '../server/developer.js';
import { emptyWorkspace, publicWorkspace, guard } from '../server/workspace.js';
import handler from '../api/v1/developer.js';
function setup() {
  let time = Date.now();
  const states = new Map([['owner', emptyWorkspace()], ['other', emptyWorkspace()]]), indexes = new Map();
  const store = {
    readWorkspace: async id => ({ workspace: states.get(id) }),
    transact: async (id, update) => { const copy = structuredClone(states.get(id)); const next = update(copy); next.revision++; states.set(id, next); return next; },
    readIndex: async digest => indexes.get(digest),
    writeIndex: async (digest, value) => indexes.set(digest, value),
  };
  const service = createDeveloperService(store, () => time);
  const create = (scopes = ['inventory:read']) => service.create('owner', { name: 'My integration', scopes, expiresInDays: 30 });
  return { states, indexes, service, create, advance: ms => { time += ms; } };
}
test('keys bind to one inventory, store only hashes, show secret once, and record actual reads', async () => {
  const { states, indexes, service, create } = setup();
  states.get('owner').items.push({ id: 'real', identity: { name: 'Owned card', game: 'pokemon' }, quantity: 3, price: 7, location: { box: 'Owner shelf', row: '2', position: 20, end: 22, stackSize: 10 }, scanPhoto: { dataUrl: 'private image' }, listings: [] });
  states.get('owner').credentials = { secret: 'seller credential' };
  states.get('other').items.push({ id: 'different workspace' });
  const { secret, key } = await create();
  assert.match(secret, /^cr_read_[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify([...states.values(), ...indexes.values()]).includes(secret));
  assert.equal(states.get('owner').apiKeys[0].hash.length, 64);
  const response = await service.read(secret, 'inventory', { limit: '1' });
  assert.equal(response.data[0].id, 'real');
  assert.equal(response.data[0].quantity, 3);
  assert.equal(response.data[0].location.position, 20);
  assert.ok(!JSON.stringify(response).includes('private image'));
  assert.ok(!JSON.stringify(response).includes('seller credential'));
  const listed = await service.list('owner');
  assert.equal(listed.keys[0].requestCount, 1);
  assert.ok(listed.keys[0].lastUsedAt);
  assert.equal(listed.keys[0].hash, undefined);
  assert.equal(listed.keys[0].secret, undefined);
  assert.equal(publicWorkspace(states.get('owner')).apiKeys, undefined);
  await assert.rejects(service.revoke('other', key.id), /not found/);
  await service.revoke('owner', key.id);
  await assert.rejects(service.read(secret, 'inventory', {}), error => error.status === 401);
});
test('permissions, expiry, invalid tokens and invalid pagination are enforced', async () => {
  const { service, create, advance } = setup();
  const { secret } = await create();
  await assert.rejects(service.read(secret, 'book', {}), error => error.status === 403);
  await assert.rejects(service.read(secret, 'inventory', { limit: '0' }), error => error.status === 400);
  await assert.rejects(service.read(secret, 'inventory', { offset: '1.2' }), error => error.status === 400);
  await assert.rejects(service.read(secret, 'keys', {}), error => error.status === 404);
  await assert.rejects(service.read('not a key', 'inventory', {}), error => error.status === 401);
  assert.deepEqual((await service.read(secret, 'inventory', {})).data, []);
  advance(31 * 86400000);
  await assert.rejects(service.read(secret, 'inventory', {}), error => error.status === 401);
});
test('read APIs paginate actual data, separate collection and hide unverified former demo positions', () => {
  const workspace = emptyWorkspace();
  workspace.items = [
    { id: 'sale', identity: { name: 'Alpha', game: 'pokemon' }, quantity: 1, location: { box: 'A', position: 4, row: '1' } },
    { id: 'collection', purpose: 'collection', identity: { name: 'Beta', game: 'pokemon' }, quantity: 2, location: { box: 'A', position: 5, end: 6, row: '1' } },
    { id: 'legacy', identity: { name: 'Old', game: 'pokemon' }, quantity: 1, location: { box: '05', position: 2100, verified: false } },
  ];
  const key = { scopes: ['inventory:read', 'book:read'] };
  assert.equal(readResource(workspace, key, 'inventory', { limit: 1 }).pagination.nextOffset, 1);
  assert.equal(readResource(workspace, key, 'inventory', { purpose: 'collection' }).data[0].id, 'collection');
  assert.equal(readResource(workspace, key, 'inventory', { q: 'Old' }).data[0].location, null);
  const locations = readResource(workspace, key, 'locations').data;
  assert.equal(locations.length, 1); assert.equal(locations[0].cardCount, 3);
  assert.equal(locations[0].ranges[1].end, 6);
  assert.deepEqual(readResource(workspace, key, 'book').data, []);
});
test('key limits and input validation prevent unsupported grants', async () => {
  const { service, create } = setup();
  await assert.rejects(create(['inventory:write']), error => error.status === 400);
  await assert.rejects(service.create('owner', { name: 'x', scopes: {}, expiresInDays: 30 }), error => error.status === 400);
  for (let i = 0; i < 10; i++) await create();
  await assert.rejects(create(), /maximum 10/);
});
test('bearer keys cannot mutate inventory or manage keys even with an owner cookie', async () => {
  const req = { method: 'POST', headers: { authorization: 'Bearer cr_read_' + 'a'.repeat(64), cookie: 'cardrails_device=' + 'b'.repeat(64), 'content-type': 'application/json' }, query: {}, body: { action: 'create', name: 'forbidden' } };
  let code, body;
  const res = { setHeader() {}, status: value => { code = value; return res; }, json: value => { body = value; return res; } };
  await handler(req, res); assert.equal(code, 405); assert.match(body.error, /read-only/);
  assert.throws(() => guard(req, res, ['GET', 'POST']), error => error.status === 403);
});
