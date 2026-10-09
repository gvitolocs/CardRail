import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const html = readFileSync(new URL('../about.html', import.meta.url), 'utf8')
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const images = html.match(/<img\b[^>]*>/g)

test('the /about landing page ships no JavaScript', () => {
  assert.doesNotMatch(html, /<script\b/i)
  assert.doesNotMatch(html, /\son[a-z]+=/i)
  assert.doesNotMatch(html, /main\.jsx/)
})

test('the landing page says Card Rails is in development and links into the desk', () => {
  assert.match(html, /In development/)
  assert.match(html, /<a class="btn btn-primary[^"]*" href="\/">Open the desk/)
})

test('landing images have dimensions and alt text, screenshots load lazily and exist', () => {
  assert.ok(images.length > 0)
  for (const img of images) {
    assert.match(img, /\swidth="\d+"/, img)
    assert.match(img, /\sheight="\d+"/, img)
    assert.match(img, /\salt="/, img)
    if (img.includes('/src/landing/img/')) assert.match(img, /loading="lazy"/, img)
  }
  for (const [, path] of html.matchAll(/\.\/(src\/landing\/[^\s")]+)/g))
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path)
})

test('only the hero font is preloaded', () => {
  const preloads = html.match(/rel="preload"[^>]*/g)
  assert.equal(preloads.length, 1)
  assert.match(preloads[0], /barlow-condensed-700-latin\.woff2/)
})

test('vercel keeps the phone pairing route and serves /about from the static page', () => {
  const rewrites = Object.fromEntries(vercel.rewrites.map((r) => [r.source, r.destination]))
  assert.equal(rewrites['/connect'], '/index.html')
  assert.equal(rewrites['/about'], '/about.html')
})
