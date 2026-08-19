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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-test-'))
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
  assert.match(fingerprint('c_cpp_zig_build'), /^0xb623d410[0-9a-f]{8}$/)
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

test('the published manifest is intact', () => {
  // The package name, the bin names and the file list are what a consumer
  // installs against; a stray edit to any of them is silent until someone
  // tries to use the published package.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'c-cpp-zig-build')
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['czb', 'c-cpp-zig-build'].sort())
  for (const entry of ['lib', 'zig', 'index.d.ts', 'README.md', 'AGENTS.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), `${entry} is missing from the published files`)
  }
  // Every dependency is pinned exactly, not ranged. For the header packages
  // that is because the headers decide what compiles; for the linter it is
  // because one that moves under you turns an unrelated commit into a diff
  // full of reformatting.
  const declared = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const [name, range] of Object.entries(declared)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} should be pinned to an exact version`)
  }
})

test('the changelog documents the version being shipped', () => {
  // A release whose changes are only in the commit log is a release nobody
  // can evaluate before installing it.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.ok(
    changelog.includes(`## [${pkg.version}]`),
    `CHANGELOG.md has no entry for ${pkg.version}`,
  )
})

test('the Zig template carries the same version as the package', () => {
  // The template is published inside the package and copied into projects; two
  // version numbers that disagree make it impossible to say what a project has.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const zon = fs.readFileSync(new URL('../zig/build.zig.zon', import.meta.url), 'utf8')
  assert.ok(
    zon.includes(`.version = "${pkg.version}"`),
    `zig/build.zig.zon does not declare version ${pkg.version}`,
  )
})

test('the pinned header packages are the versions that were tested', () => {
  // Reading them back from disk catches a package.json edit that was never
  // installed, and an install that resolved to something else.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const name of ['node-addon-api', 'node-api-headers']) {
    const installed = JSON.parse(
      fs.readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
    )
    assert.equal(installed.version, pkg.dependencies[name], `${name} on disk differs from the pin`)
    // Neither may grow a dependency tree: that is the reason both are
    // acceptable dependencies of a build tool in the first place.
    assert.deepEqual(Object.keys(installed.dependencies ?? {}), [])
  }
})

test('node-addon-api still supports the Node versions this package claims', () => {
  // Pinning forwards is only safe while the header package still runs on the
  // oldest Node in `engines`. When that stops being true, the pin has to stop
  // moving, or `engines` has to.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const addonApi = JSON.parse(
    fs.readFileSync(
      new URL('../node_modules/node-addon-api/package.json', import.meta.url),
      'utf8',
    ),
  )
  const ourMajor = Number(/(\d+)/.exec(pkg.engines.node)[1])
  assert.match(
    addonApi.engines.node,
    new RegExp(`\\b${ourMajor}\\b`),
    `node-addon-api ${addonApi.version} does not list Node ${ourMajor}: ${addonApi.engines.node}`,
  )
})

test('findUp stops at the filesystem root instead of looping', () => {
  assert.equal(findUp(os.tmpdir(), 'this-file-does-not-exist-anywhere'), undefined)
})
