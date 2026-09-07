import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { chooseExtractor, extractArchive, withLock } from '../lib/download.js'
import { toIdentifier } from '../lib/fsutil.js'
import { detectHostTriple } from '../lib/host.js'
import { progressTarget } from '../lib/log.js'
import {
  resolveNodeAddonApi,
  resolveNodeApiHeaders,
  resolveNodeHeaders,
} from '../lib/node-headers.js'
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

test('a zip is never handed to GNU tar', () => {
  // Two separate Windows facts, both of which bit: GNU tar cannot read a zip
  // at all, and it reads `C:\...` as `host:path` and tries to open a network
  // connection — `tar: Cannot connect to C: resolve failed`. A Git Bash or
  // MSYS2 shell puts its own GNU tar ahead of the bsdtar Windows ships, so
  // this is the `tar` a build finds there.
  const gnuOnWindows = {
    flavour: 'gnu',
    systemTar: 'C:\\Windows\\System32\\tar.exe',
    windows: true,
  }

  // Reach past the GNU tar on PATH to the bsdtar in System32.
  assert.deepEqual(chooseExtractor({ archive: 'zig.zip', ...gnuOnWindows }), {
    kind: 'tar',
    exe: 'C:\\Windows\\System32\\tar.exe',
    forceLocal: false,
  })

  // Before 1803 there is no bsdtar to reach for, so PowerShell it is.
  assert.deepEqual(
    chooseExtractor({ archive: 'zig.zip', flavour: 'gnu', systemTar: undefined, windows: true }),
    { kind: 'expand-archive' },
  )

  // Off Windows there is no fallback, so say so rather than let GNU tar fail
  // with "this does not look like a tar archive".
  assert.deepEqual(
    chooseExtractor({ archive: 'x.zip', flavour: 'gnu', systemTar: undefined, windows: false }),
    { kind: 'none' },
  )
})

test('GNU tar gets --force-local on Windows, bsdtar never does', () => {
  // `--force-local` is what stops `C:\...` being read as a remote host.
  // bsdtar does not need it and does not accept it.
  assert.equal(
    chooseExtractor({ archive: 'x.tar.gz', flavour: 'gnu', windows: true }).forceLocal,
    true,
  )
  assert.equal(
    chooseExtractor({ archive: 'x.tar.gz', flavour: 'bsdtar', windows: true }).forceLocal,
    false,
  )
  assert.equal(
    chooseExtractor({ archive: 'x.tar.xz', flavour: 'gnu', windows: false }).forceLocal,
    false,
  )
})

test('extractArchive unpacks a tarball and strips its top level', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-tar-'))
  fs.mkdirSync(path.join(dir, 'src', 'pkg-1.0.0', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'pkg-1.0.0', 'run'), 'binary\n')
  fs.writeFileSync(path.join(dir, 'src', 'pkg-1.0.0', 'lib', 'a.txt'), 'a\n')
  spawnSync('tar', ['-czf', path.join(dir, 'pkg.tar.gz'), '-C', path.join(dir, 'src'), 'pkg-1.0.0'])

  const out = path.join(dir, 'out')
  await extractArchive(path.join(dir, 'pkg.tar.gz'), out, { stripComponents: 1 })
  assert.ok(fs.existsSync(path.join(out, 'run')), 'the top-level directory should be stripped')
  assert.equal(fs.readFileSync(path.join(out, 'lib', 'a.txt'), 'utf8'), 'a\n')
})

test('a supervised build gets lines, not a bar it cannot own', () => {
  // turbo and CI write to the terminal line by line whenever they please. A bar
  // repainting between those lines overwrites them, and its closing erase takes
  // whatever shared the line. Zig's own progress display switches itself off in
  // exactly this situation; this switches to lines.
  assert.deepEqual(progressTarget({ stdout: { isTTY: true }, env: {} }), { repaint: true })

  for (const env of [{ TURBO_HASH: 'b8f7' }, { CI: '1' }, { NO_COLOR: '1' }]) {
    assert.deepEqual(progressTarget({ stdout: { isTTY: true }, env }), { repaint: false })
  }
  assert.deepEqual(progressTarget({ stdout: { isTTY: false }, env: {} }), { repaint: false })

  assert.deepEqual(
    progressTarget({ stdout: { isTTY: true }, env: { C_CPP_ZIG_BUILD_PROGRESS: 'lines' } }),
    { repaint: false },
  )
  assert.deepEqual(
    progressTarget({ stdout: { isTTY: true }, env: { C_CPP_ZIG_BUILD_PROGRESS: 'off' } }),
    { repaint: false, silent: true },
  )
})

test('a download with no terminal to draw on reports progress in the log', async () => {
  // Run in a child process on purpose: what matters is what reaches a pipe,
  // which is what turbo and CI see. Not every community mirror sends a
  // Content-Length, and one that streams the archive chunked cannot, so the
  // size from the Zig index is passed in and preferred over the header.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-bar-'))
  const script = path.join(dir, 'download.mjs')
  const downloadUrl = new URL('../lib/download.js', import.meta.url).href
  fs.writeFileSync(
    script,
    `import http from 'node:http'
     import { downloadFile } from ${JSON.stringify(downloadUrl)}
     const size = 512 * 1024
     const body = Buffer.alloc(size, 7)
     const server = http.createServer((_req, res) => {
       res.writeHead(200, { 'Content-Type': 'application/octet-stream' }) // chunked: no length
       let sent = 0
       const tick = setInterval(() => {
         if (sent >= size) { clearInterval(tick); res.end(); return }
         res.write(body.subarray(sent, sent + size / 16))
         sent += size / 16
       }, 5)
     })
     await new Promise((r) => server.listen(0, '127.0.0.1', r))
     const url = \`http://127.0.0.1:\${server.address().port}/zig.zip\`
     await downloadFile(url, ${JSON.stringify(path.join(dir, 'a.zip'))}, {
       label: 'zig.zip',
       size,
     })
     server.close()
    `,
  )

  // CI=1 stands in for "there is no terminal to draw on": without it the child
  // would find the developer's own terminal through /dev/tty and paint the bar
  // there, leaving this pipe empty — correct behaviour, useless as a fixture.
  const { status, stdout } = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  assert.equal(status, 0, stdout)

  const percentages = [...stdout.matchAll(/zig\.zip \[[#-]{24}\] (\d+)%/g)].map((m) => Number(m[1]))
  // A known size is what makes a bar possible at all; without one the output
  // degrades to counting megabytes.
  assert.ok(percentages.length >= 5, `expected progress lines, got:\n${stdout}`)
  // One line per fifth keeps a supervised log short, and the last must reach
  // 100%, not stop at 80% where the final chunk happens to land.
  assert.equal(percentages.at(-1), 100, `progress should end at 100%:\n${stdout}`)
  assert.deepEqual(
    percentages,
    [...percentages].sort((a, b) => a - b),
    'progress should only ever move forwards',
  )
})

test('a lock left behind by a dead process is taken over, not waited on', async () => {
  // `finally` does not run when a build is killed with Ctrl+C, so an
  // interrupted download leaves its lock. Waiting it out was a ten-minute hang
  // with no output and no CPU — indistinguishable from a crash.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-lock-'))
  const lock = path.join(dir, '.zig.lock')
  fs.writeFileSync(lock, '99999999') // a pid that cannot be running

  const started = Date.now()
  assert.equal(await withLock(lock, async () => 'ran', { timeoutMs: 5000 }), 'ran')
  assert.ok(Date.now() - started < 1000, 'a dead owner should not be waited on at all')
  assert.ok(!fs.existsSync(lock), 'the lock should be released afterwards')
})

test('a lock held by a living process is respected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-lock-'))
  const lock = path.join(dir, '.zig.lock')
  fs.writeFileSync(lock, String(process.pid)) // alive by definition

  await assert.rejects(
    () => withLock(lock, async () => 'ran', { timeoutMs: 400 }),
    /timed out waiting for lock/,
  )
  assert.ok(fs.existsSync(lock), "someone else's lock must not be deleted")
})

test('an unreadable or ageing lock does not block forever either', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czb-lock-'))
  const lock = path.join(dir, '.zig.lock')

  // Written by a build that died between creating the file and naming itself.
  fs.writeFileSync(lock, '')
  assert.equal(await withLock(lock, async () => 'ran', { timeoutMs: 5000 }), 'ran')

  // Held by a live pid, but old enough that the pid has plausibly been reused.
  fs.writeFileSync(lock, String(process.pid))
  assert.equal(await withLock(lock, async () => 'ran', { timeoutMs: 5000, staleAfterMs: 0 }), 'ran')
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

  const apiHeaders = resolveNodeApiHeaders(bare)
  assert.ok(apiHeaders, 'node-api-headers should resolve from this package')
  assert.equal(apiHeaders.declared, false)
  // The .def file is the only route to a Bun import library on Windows.
  assert.ok(fs.existsSync(apiHeaders.nodeApiDef))
})

test('the Node headers come from node-api-headers, with nothing downloaded', () => {
  const bare = tempProject({ 'package.json': JSON.stringify({ name: 'bare' }) })

  const headers = resolveNodeHeaders({ root: bare })
  assert.match(headers.source, /^node-api-headers /)
  assert.ok(fs.existsSync(path.join(headers.includeDir, 'node_api.h')))
  // The full Node header set is deliberately not here: an addon reaching for
  // V8 directly is pinned to one Node build, which Node-API exists to avoid.
  assert.ok(!fs.existsSync(path.join(headers.includeDir, 'v8.h')))
})

test('an explicit nodeHeaders directory wins, and is checked', () => {
  const project = tempProject({
    'package.json': JSON.stringify({ name: 'own-headers' }),
    'vendor/include/node_api.h': '/* pretend */\n',
    'vendor/empty/.keep': '',
  })

  const headers = resolveNodeHeaders({ root: project, nodeHeaders: 'vendor/include' })
  assert.equal(headers.source, 'configured')
  assert.equal(headers.includeDir, path.join(project, 'vendor', 'include'))

  // A silent fallback to the bundled headers would compile the wrong thing.
  assert.throws(
    () => resolveNodeHeaders({ root: project, nodeHeaders: 'vendor/nowhere' }),
    /missing directory/,
  )
  assert.throws(
    () => resolveNodeHeaders({ root: project, nodeHeaders: 'vendor/empty' }),
    /no node_api\.h/,
  )
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
  assert.equal(resolveNodeApiHeaders(declaring).declared, false)
})

test('nothing in lib/ reaches for nodejs.org', () => {
  // Since 0.3.0 the Node-API headers come from `node-api-headers` and the
  // Windows import library is generated locally from its .def file. Nothing is
  // fetched from nodejs.org any more, and this is what keeps that true.
  const dir = new URL('../lib/', import.meta.url)
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8')
    assert.ok(!source.includes('nodejs.org'), `lib/${file} still references nodejs.org`)
    assert.ok(!source.includes('node.lib'), `lib/${file} still references node.lib`)
  }
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
