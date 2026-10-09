import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeQr } from '../src/core/qr.js'

test('the pairing URL encodes (falls back from H to M when it is too long)', () => {
  const url = `https://cardrails.vercel.app/#capture=${'a'.repeat(32)}&key=${'b'.repeat(48)}&code=1234`
  const qr = encodeQr(url, { ecc: 'H' })
  assert.equal(qr.ecc, 'M')
  assert.ok(qr.version <= 10)
  assert.equal(encodeQr('cardrails:B01-R1-5', { ecc: 'H' }).ecc, 'H')
  assert.throws(() => encodeQr('x'.repeat(400)), /too long/)
})
