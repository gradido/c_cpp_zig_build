/*
 * The point of this example, as an executable check.
 *
 * A native addon is a build output like any other, but it is the one people
 * most often forget to declare: `zig build` writes a file that no bundler and
 * no `node_modules` install would ever produce again. If `turbo.json` does not
 * name it under `outputs`, turbo still reports a cache hit and still replays
 * the log line that says the addon was built — and the file is not there.
 *
 * These checks pin down both halves: that the outputs really are visible with
 * the configuration in this repository, and that they really do vanish without
 * it. Run them with `npm test`, or on their own with `npm run check`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const turboExe = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'turbo.cmd' : 'turbo',
)
const addon = path.join(root, 'packages', 'checksum', 'build', 'crc32_addon.node')
const manifest = path.join(root, 'packages', 'app', 'dist', 'manifest.json')
const uncachedDir = path.join(root, 'packages', 'checksum', '.uncached-build')

/** Runs turbo from the workspace root and returns everything it printed. */
function turbo(...args) {
  assert.ok(
    fs.existsSync(turboExe),
    'turbo is not installed here — run `bun install` (or `npm install`) in this directory first',
  )
  const result = spawnSync(turboExe, ['run', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Colour codes and the update notice would only make the assertions
      // below harder to read; the TUI would reorder the lines outright.
      FORCE_COLOR: '0',
      TURBO_TELEMETRY_DISABLED: '1',
      TURBO_NO_UPDATE_NOTIFIER: '1',
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `\`turbo run ${args.join(' ')}\` failed:\n${output}`)
  return output
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function loadAddon() {
  delete require.cache[require.resolve(addon)]
  return require(addon)
}

test('a cold build streams the compiler output through turbo', () => {
  const output = turbo('build', '--force')

  // `--force` guarantees the task really runs; turbo calls that a bypass.
  assert.match(
    output,
    /@turbo-example\/checksum:build: cache (miss, executing|bypass, force executing)/,
  )
  // The build tool's own line, not turbo's summary: what the compiler says is
  // not swallowed on the way through.
  assert.match(output, /@turbo-example\/checksum:build: \[checksum\] built /)
  assert.match(output, /@turbo-example\/app:build: wrote dist\/manifest\.json/)
})

test('the addon lands exactly where turbo.json declares the outputs', () => {
  assert.ok(fs.existsSync(addon), `${addon} should exist after a build`)
  assert.equal(loadAddon().crc32('123456789'), 0xcbf43926)
})

test('a cache hit restores the addon, not only its log line', () => {
  const before = sha256(addon)

  fs.rmSync(path.dirname(addon), { recursive: true, force: true })
  fs.rmSync(path.dirname(manifest), { recursive: true, force: true })
  assert.ok(!fs.existsSync(addon), 'the addon should be gone before the cached run')

  const output = turbo('build')
  assert.match(output, /@turbo-example\/checksum:build: cache hit, replaying logs/)
  assert.match(output, /FULL TURBO/)

  assert.ok(fs.existsSync(addon), 'turbo restored the log but not the .node file')
  assert.equal(sha256(addon), before, 'the restored addon differs from the one that was cached')
  assert.ok(fs.existsSync(manifest), 'the downstream package output was not restored either')

  // Restored, and still a loadable addon: the executable bit and the file mode
  // survived the round trip through the cache.
  assert.equal(loadAddon().crc32('123456789'), 0xcbf43926)
})

test('the downstream build step really called the addon', () => {
  const source = fs.readFileSync(path.join(root, 'packages', 'app', 'index.mjs'))
  const recorded = JSON.parse(fs.readFileSync(manifest, 'utf8'))

  assert.equal(recorded.bytes, source.length)
  assert.equal(recorded.crc32, loadAddon().crc32(source))
})

test('without `outputs`, a cache hit leaves nothing behind — the trap', () => {
  // `build:uncached` runs the identical compile into a different directory,
  // and turbo.json gives it `"outputs": []`. Everything else is the same.
  turbo('build:uncached', '--force')
  assert.ok(
    fs.existsSync(path.join(uncachedDir, 'crc32_addon.node')),
    'the build should produce an addon',
  )

  fs.rmSync(uncachedDir, { recursive: true, force: true })

  const output = turbo('build:uncached')
  assert.match(output, /cache hit, replaying logs/)
  assert.match(output, /FULL TURBO/)
  // turbo says it built the addon. It did not, and it restored nothing,
  // because nothing was ever cached.
  assert.match(output, /\[checksum\] built /)
  assert.ok(
    !fs.existsSync(uncachedDir),
    'a task with no declared outputs should restore nothing — if this fails, turbo changed',
  )
})
