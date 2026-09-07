import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import checksum from '@turbo-example/checksum'

import { manifest } from './index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('the build step produced a manifest', () => {
  const { file, bytes, crc32 } = manifest()
  assert.equal(file, 'index.mjs')
  assert.equal(typeof crc32, 'number')
  assert.equal(typeof bytes, 'number')
})

test('the manifest agrees with the addon, so it was not stale', () => {
  const source = fs.readFileSync(path.join(here, 'index.mjs'))
  assert.equal(manifest().crc32, checksum.crc32(source))
  assert.equal(manifest().bytes, source.length)
})
