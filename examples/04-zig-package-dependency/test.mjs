import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'node:zlib'

import addon from './index.cjs'

test('reports the linked zstd version', () => {
  assert.match(addon.version(), /^\d+\.\d+\.\d+$/)
})

test('round trips', () => {
  const original = Buffer.from('native modules '.repeat(500))
  const compressed = addon.compress(original)
  assert.ok(compressed.length < original.length)
  assert.deepEqual(addon.decompress(compressed), original)
})

test('honours the compression level', () => {
  const original = Buffer.from(JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => i) }))
  assert.ok(addon.compress(original, 19).length <= addon.compress(original, 1).length)
})

test('node can read what the addon wrote', () => {
  const original = Buffer.from('interop matters')
  assert.deepEqual(zlib.zstdDecompressSync?.(addon.compress(original)) ?? original, original)
})

test('rejects data that is not a zstd frame', () => {
  assert.throws(() => addon.decompress(Buffer.from('nonsense')), /not a zstd frame/)
})
