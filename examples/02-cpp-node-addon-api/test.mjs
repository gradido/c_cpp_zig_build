import assert from 'node:assert/strict'
import test from 'node:test'

import addon from './index.cjs'

test('multiplies two matrices', () => {
  const a = [
    [1, 2],
    [3, 4],
  ]
  const b = [
    [5, 6],
    [7, 8],
  ]
  assert.deepEqual(addon.multiply(a, b), [
    [19, 22],
    [43, 50],
  ])
})

test('identity leaves a matrix alone', () => {
  const a = [
    [1, 2, 3],
    [4, 5, 6],
  ]
  const identity = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  assert.deepEqual(addon.multiply(a, identity), a)
})

test('a C++ exception arrives as a JS error', () => {
  assert.throws(() => addon.multiply([[1, 2]], [[1, 2]]), /shapes do not line up/)
})

test('bad input is rejected with a TypeError', () => {
  assert.throws(() => addon.multiply(42, 7), TypeError)
})
