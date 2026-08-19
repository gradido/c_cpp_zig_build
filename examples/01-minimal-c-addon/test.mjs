import assert from 'node:assert/strict'
import test from 'node:test'

import addon from './index.cjs'

test('add', () => {
  assert.equal(addon.add(2, 3), 5)
  assert.equal(addon.add(-1, 1), 0)
})

test('fib returns a BigInt, so large values stay exact', () => {
  assert.equal(addon.fib(10), 55n)
  assert.equal(addon.fib(90), 2880067194370816120n)
  assert.equal(addon.fib(-1), 0n)
})
