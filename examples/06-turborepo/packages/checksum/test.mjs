import assert from 'node:assert/strict'
import test from 'node:test'

import checksum from './index.cjs'

test('crc32 matches the published IEEE test vectors', () => {
  assert.equal(checksum.crc32(''), 0)
  assert.equal(checksum.crc32('a'), 0xe8b7be43)
  assert.equal(checksum.crc32('123456789'), 0xcbf43926)
})

test('a string and its UTF-8 bytes check out the same', () => {
  const text = 'grüße aus dem build'
  assert.equal(checksum.crc32(text), checksum.crc32(Buffer.from(text, 'utf8')))
  assert.equal(checksum.crc32(text), checksum.crc32(new Uint8Array(Buffer.from(text, 'utf8'))))
})

test('anything else is a TypeError', () => {
  assert.throws(() => checksum.crc32(42), TypeError)
  assert.throws(() => checksum.crc32(new Float64Array(2)), TypeError)
})
