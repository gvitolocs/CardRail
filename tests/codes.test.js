import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CONDITIONS, DICTIONARY_VERSION, FLAGS, GAMES, LANGUAGES, PRINTINGS, decodeCompactRow, encodeImportRow } from '../src/core/codes.js'

// Recorded from GET /v1/dictionary; the iPhone and Android tests read the same file.
const server = JSON.parse(readFileSync(new URL('../ios/CardRailsTests/Fixtures/api/dictionary.json', import.meta.url)))
const table = (values) => Object.fromEntries(values.map((value, i) => [String(i + 1), value]))

test('dictionary matches the API', () => {
  assert.equal(server.version, DICTIONARY_VERSION)
  assert.deepEqual(server.games, table(GAMES))
  assert.deepEqual(server.languages, table(LANGUAGES))
  assert.deepEqual(server.conditions, table(CONDITIONS))
  assert.deepEqual(server.printings, table(PRINTINGS))
  assert.deepEqual(server.flags, Object.fromEntries(Object.entries(FLAGS).map(([name, bit]) => [String(bit), name])))
})

test('compact row round trip', () => {
  const copy = decodeCompactRow([12, 219698, 1, 2, 3, 2, 3, 350, 0, 1, 5, 7, 4, 1 | 16], ['A01'])
  assert.equal(copy.seq, 12)
  assert.equal(copy.publicId, '219698')
  assert.equal(copy.game, 'pokemon')
  assert.equal(copy.language, 'IT')
  assert.equal(copy.condition, 'SP')
  assert.equal(copy.printing, 'Holo')
  assert.equal(copy.price, 3.5)
  assert.deepEqual(copy.location, { box: 'A01', row: '1', position: 5, end: 7 })
  assert.equal(copy.firstEdition, true)
  assert.equal(copy.imported, true)
  assert.deepEqual(encodeImportRow({ ...copy, publicId: copy.publicId }), [219698, 1, 2, 3, 2, 3, 350, 1])
  const manual = decodeCompactRow([13, null, 2, 1, 2, 'Etched Foil', 1, 0, null, null, null, null, 1, 8, { n: 'Sol Ring', s: 'Promo', k: '1' }], [])
  assert.equal(manual.printing, 'Etched Foil')
  assert.equal(manual.location, null)
  assert.equal(manual.purpose, 'collection')
  assert.equal(manual.name, 'Sol Ring')
})
