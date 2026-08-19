import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { findUp, toIdentifier } from '../lib/fsutil.js'
import { detectHostTriple, detectNodeVersion, nodeWindowsArch } from '../lib/host.js'
import { resolveNodeAddonApi, resolveNodeApiHeadersPackage } from '../lib/node-headers.js'
import { fingerprint } from '../lib/scaffold.js'
import { packagedTemplateDir } from '../lib/template.js'

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znb-test-'))
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  return dir
}

test('toIdentifier produces valid C identifiers', () => {
  assert.equal(toIdentifier('@scope/my-addon'), 'my_addon')
  assert.equal(toIdentifier('geosearch-native'), 'geosearch_native')
  assert.equal(toIdentifier('9lives'), '_9lives')
  assert.equal(toIdentifier('---'), 'native')
})

test('fingerprint matches the value Zig computes', () => {
  // Zig reports these when the field is wrong; the high half is CRC-32 of the
  // package name and must match exactly.
  assert.match(fingerprint('minimal_addon'), /^0xcb0404b8[0-9a-f]{8}$/)
  assert.match(fingerprint('zig_native_build'), /^0x5e787703[0-9a-f]{8}$/)
  assert.match(fingerprint('blockchain_core'), /^0x838910c1[0-9a-f]{8}$/)
})

test('fingerprint ids vary, so forks do not collide', () => {
  assert.notEqual(fingerprint('same_name'), fingerprint('same_name'))
})

test('the host triple is one Zig understands', async () => {
  assert.match(await detectHostTriple(), /^[a-z0-9_]+-[a-z]+(-[a-z0-9]+)?$/)
})

test('nodeWindowsArch maps triples to nodejs.org directories', () => {
  assert.equal(nodeWindowsArch('x86_64-windows'), 'win-x64')
  assert.equal(nodeWindowsArch('aarch64-windows'), 'win-arm64')
  assert.throws(() => nodeWindowsArch('x86_64-linux-gnu'))
})

test('a .nvmrc pins the Node version, an alias does not', () => {
  const pinned = tempProject({ '.nvmrc': 'v20.11.1\n' })
  assert.equal(detectNodeVersion(pinned), '20.11.1')

  const alias = tempProject({ '.nvmrc': 'lts/*\n' })
  assert.equal(detectNodeVersion(alias), process.versions.node)
})

test('an addon is detected from a napi/ directory', async () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'thing-native' }),
    'napi/binding.c': '',
  })
  const config = await resolveConfig({ root: dir })
  assert.equal(config.napi, true)
  assert.equal(config.name, 'thing_native')
})

test('a plain library project is not treated as an addon', async () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'plain' }),
    'src/plain.c': '',
  })
  const config = await resolveConfig({ root: dir })
  assert.equal(config.napi, false)
})

test('an index.cjs that loads a .node counts as an addon', async () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'thing' }),
    'index.cjs': "module.exports = require('./build/thing.node')\n",
  })
  assert.equal((await resolveConfig({ root: dir })).napi, true)
})

test('the package.json zigNative field is picked up', async () => {
  const dir = tempProject({
    'package.json': JSON.stringify({
      name: 'thing',
      zigNative: { optimize: 'fast', outDir: 'out' },
    }),
  })
  const config = await resolveConfig({ root: dir })
  assert.equal(config.optimize, 'ReleaseFast')
  assert.equal(config.outDir, 'out')
})

test('a config file wins over package.json, and overrides win over both', async () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'thing', zigNative: { optimize: 'fast' } }),
    'zig-native.config.json': JSON.stringify({ optimize: 'safe', outDir: 'from-file' }),
  })
  assert.equal((await resolveConfig({ root: dir })).optimize, 'ReleaseSafe')
  assert.equal((await resolveConfig({ root: dir, optimize: 'debug' })).optimize, 'Debug')
  assert.equal((await resolveConfig({ root: dir })).outDir, 'from-file')
})

test('an unknown optimize mode is rejected by name', async () => {
  await assert.rejects(
    resolveConfig({ root: tempProject({}), optimize: 'turbo' }),
    /unknown optimize mode/,
  )
})

test('targets accept a string, an array and a map', async () => {
  const root = tempProject({})
  const one = await resolveConfig({ root, targets: 'aarch64-macos' })
  assert.deepEqual(Object.keys(one.targets), ['aarch64-macos'])

  const many = await resolveConfig({ root, targets: ['x86_64-linux-gnu', 'aarch64-macos'] })
  assert.deepEqual(Object.keys(many.targets), ['x86_64-linux-gnu', 'aarch64-macos'])

  const named = await resolveConfig({
    root,
    targets: { legacy: { triple: 'x86_64-linux-gnu', glibc: '2.28' } },
  })
  assert.equal(named.targets.legacy.glibc, '2.28')
})

test('the shipped Zig template is complete', () => {
  const dir = packagedTemplateDir()
  for (const file of [
    'build.zig',
    'build.zig.zon',
    'src/sources.zig',
    'src/napi.zig',
    'src/compile_commands.zig',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} is missing from the package`)
  }
})

test('the bundled header packages are always resolvable', () => {
  // A project that declares nothing still gets both, because they are
  // dependencies of this package. This is what lets a C++ addon and a Windows
  // build work with no setup.
  const bare = tempProject({ 'package.json': JSON.stringify({ name: 'bare' }) })

  const addonApi = resolveNodeAddonApi(bare)
  assert.ok(addonApi, 'node-addon-api should resolve from this package')
  assert.equal(addonApi.declared, false)
  assert.ok(fs.existsSync(path.join(addonApi.includeDir, 'napi.h')))

  const apiHeaders = resolveNodeApiHeadersPackage(bare)
  assert.ok(apiHeaders, 'node-api-headers should resolve from this package')
  assert.equal(apiHeaders.declared, false)
  // The .def file is the only route to a Bun import library on Windows.
  assert.ok(fs.existsSync(apiHeaders.nodeApiDef))
})

test('a package the project declares is reported as its own', () => {
  // Declaration is read from package.json, not inferred from where the file
  // turned up: npm hoists this package's dependencies into the consumer's
  // node_modules, so the resolved path cannot tell the two apart.
  const declaring = tempProject({
    'package.json': JSON.stringify({
      name: 'declaring',
      devDependencies: { 'node-addon-api': '^8.7.0' },
    }),
  })
  assert.equal(resolveNodeAddonApi(declaring).declared, true)
  assert.equal(resolveNodeApiHeadersPackage(declaring).declared, false)
})

test('findUp stops at the filesystem root instead of looping', () => {
  assert.equal(findUp(os.tmpdir(), 'this-file-does-not-exist-anywhere'), undefined)
})
