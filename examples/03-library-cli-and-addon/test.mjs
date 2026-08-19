import assert from 'node:assert/strict'
import test from 'node:test'

import addon from './index.cjs'

test('measures a buffer', () => {
  const stats = addon.measure(Buffer.from('hello\nworld of native modules\n'))
  assert.equal(stats.bytes, 30)
  assert.equal(stats.lines, 2)
  assert.equal(stats.longestLine, 23)
  assert.equal(typeof stats.hash, 'bigint')
})

test('strings and buffers hash the same', () => {
  const text = 'the quick brown fox\n'
  assert.equal(addon.measure(text).hash, addon.measure(Buffer.from(text)).hash)
})

test('a trailing fragment counts as a line', () => {
  assert.equal(addon.measure('a\nb').lines, 2)
  assert.equal(addon.measure('a\nb\n').lines, 2)
  assert.equal(addon.measure('').lines, 0)
})

test('the seed comes from the flag build.zig passes to third_party', () => {
  assert.equal(addon.seed(), 0xcbf29ce484222325n)
})
