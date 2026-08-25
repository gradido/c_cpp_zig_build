import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import addon from './index.cjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('the addon links the package that reads the working directory', () => {
  assert.equal(addon.sum([1, 2, 3, 4]), 10)
  assert.equal(addon.sum([]), 0)
  assert.equal(addon.sum([-5, 5]), 0)
})

test('sum rejects anything that is not an array of numbers', () => {
  assert.throws(() => addon.sum(), TypeError)
  assert.throws(() => addon.sum('123'), TypeError)
  assert.throws(() => addon.sum([1, 'two']), TypeError)
})

test('this project really has no src/ of its own', () => {
  // The whole point: with a src/ here, the dependency would have found *that*
  // one and the build would have gone through for the wrong reason. If someone
  // adds one later, this example stops testing what it was written to test.
  assert.equal(fs.existsSync(path.join(here, 'src')), false)
})

test('the dependency still reads the working directory', () => {
  // The mistake is the fixture. Were it ever tidied up, the build would go
  // through whatever the template did, and nothing here would notice.
  const build = fs.readFileSync(path.join(here, 'vendor/tallies/build.zig'), 'utf8')
  assert.match(build, /std\.fs\.cwd\(\)\.openDir\(root/)
})
