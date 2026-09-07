#!/usr/bin/env node
/**
 * The Windows half of building an addon, which nothing else covers.
 *
 * A Windows DLL may not have undefined symbols, so the addon must link an
 * import library. `node-api-headers` ships a module definition file and the
 * template turns it into one with `zig dlltool` — once against `node.exe`, and
 * again against `bun.exe` for the separate Bun addon. That chain is three
 * pieces deep and none of it runs on a Linux or macOS build, so a break in it
 * used to surface only on somebody's Windows machine.
 *
 * Most of it can be checked anywhere, because a cross compiled addon is a real
 * PE file: the import table names the executable its symbols come from. What
 * cannot be checked off Windows is loading it, so that part runs there only.
 *
 * Run with `npm run test:windows`.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = path.join(root, 'examples', '01-minimal-c-addon')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-windows-'))

const TARGETS = ['x86_64-windows', 'aarch64-windows']

/** Builds both Windows targets once, and returns everything the CLI printed. */
function build() {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'lib', 'cli.js'),
      'build',
      // `--bun` rather than the default: whether a Bun addon is built should
      // not depend on whether Bun happens to be installed on this machine.
      '--bun',
      '--verbose',
      '--out-dir',
      outDir,
      ...TARGETS.flatMap((triple) => ['--target', triple]),
    ],
    { cwd: project, encoding: 'utf8' },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `the Windows cross build failed:\n${output}`)
  return output
}

const output = build()

/** True when `needle` appears in the file's bytes. */
function contains(file, needle) {
  return fs.readFileSync(file).includes(Buffer.from(needle, 'latin1'))
}

test('the import library comes from node-api-headers, never from a download', () => {
  assert.match(output, /-Dnode-api-def=\S+node_api\.def/)
  assert.doesNotMatch(output, /-Dnode-lib=/)
})

for (const triple of TARGETS) {
  test(`${triple}: the addon is a PE that imports from node.exe`, () => {
    const addon = path.join(outDir, triple, 'minimal_addon.node')
    assert.ok(fs.existsSync(addon), `${addon} should exist`)
    // `MZ`, so this really is a Windows binary and not a host one misnamed.
    assert.equal(fs.readFileSync(addon).subarray(0, 2).toString('latin1'), 'MZ')
    // The import descriptor names the executable the symbols resolve against.
    // Getting this wrong is what an addon that will not load looks like.
    assert.ok(contains(addon, 'node.exe'), 'should import from node.exe')
    assert.ok(!contains(addon, 'bun.exe'), 'the Node addon should not import from bun.exe')
    assert.ok(contains(addon, 'napi_create_bigint_uint64'), 'should import a Node-API symbol')
  })

  test(`${triple}: the Bun addon is the same code against bun.exe`, () => {
    // Bun exports the Node-API from bun.exe, so it needs its own import
    // library. The `.def` route is the only one that can produce it.
    const addon = path.join(outDir, triple, 'minimal_addon.bun.node')
    assert.ok(fs.existsSync(addon), `${addon} should exist`)
    assert.equal(fs.readFileSync(addon).subarray(0, 2).toString('latin1'), 'MZ')
    assert.ok(contains(addon, 'bun.exe'), 'should import from bun.exe')
    assert.ok(!contains(addon, 'node.exe'), 'the Bun addon should not import from node.exe')
  })
}

test('the addon loads and runs', {
  skip: process.platform === 'win32' ? false : 'only a Windows host can load a Windows addon',
}, () => {
  const triple = process.arch === 'arm64' ? 'aarch64-windows' : 'x86_64-windows'
  const addon = createRequire(import.meta.url)(path.join(outDir, triple, 'minimal_addon.node'))
  assert.equal(addon.add(2, 3), 5)
  assert.equal(addon.fib(90), 2880067194370816120n)
})

test.after?.(() => fs.rmSync(outDir, { recursive: true, force: true }))
