/*
 * Puts this workspace back to how it comes out of a clone, so the next
 * `bun run build` is a genuinely cold run.
 *
 * `turbo run clean` removes what each package built, by asking each package.
 * This goes further, and deliberately needs neither turbo nor the build tool to
 * be working: it also drops turbo's own cache, without which a second build is
 * a cache hit and the checks in check-turbo-cache.mjs prove nothing.
 *
 * Everything listed here is derived output. `node_modules` is left alone;
 * reinstalling turbo is not what makes a run cold.
 *
 *   bun run clear              reset the workspace
 *   bun run clear --toolchain  and drop the downloaded Zig, to watch the
 *                              toolchain download happen again
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

const derived = [
  // turbo's task cache, and the per-package log directories it writes
  '.turbo',
  'packages/app/.turbo',
  'packages/checksum/.turbo',
  // written by packages/app's build step
  'packages/app/dist',
  // written by c-cpp-zig-build into the addon package
  'packages/checksum/build',
  'packages/checksum/.zig-cache',
  'packages/checksum/.zig-native',
  'packages/checksum/compile_commands.json',
  // the deliberately uncached output directory check-turbo-cache.mjs builds into
  'packages/checksum/.uncached-build',
]

const removed = []
for (const relative of derived) {
  const target = path.join(root, relative)
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(relative)
  }
}

if (process.argv.includes('--toolchain')) {
  // Shared with every other project on this machine, which is why it takes a
  // flag: without it the next build reuses the toolchain and the download —
  // the slow, interesting part — never happens again.
  const home = process.env.C_CPP_ZIG_BUILD_HOME || path.join(os.homedir(), '.zig-build')
  const zig = path.join(home, 'zig')
  if (fs.existsSync(zig)) {
    fs.rmSync(zig, { recursive: true, force: true })
    removed.push(zig)
  }
}

for (const entry of removed) {
  process.stdout.write(`removed ${entry}\n`)
}
process.stdout.write(
  removed.length === 0
    ? 'nothing to remove; this workspace is already cold\n'
    : '\nready — the next `bun run build` will be a cache miss\n',
)
