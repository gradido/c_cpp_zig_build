/*
 * Puts this workspace back to how it comes out of a clone, so the next
 * `bun run build` is a genuinely cold run.
 *
 * `turbo run clean` removes what each package built, by asking each package.
 * This goes further, and deliberately needs neither turbo nor the build tool to
 * be working: it also drops turbo's task cache, without which a second build is
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

/** Derived output that can appear in any workspace. */
const PER_WORKSPACE = [
  '.turbo', // turbo's per-task logs
  'dist', // written by packages/app's build step
  'build', // the addon, written by c-cpp-zig-build
  '.zig-cache', // Zig's own incremental cache
  '.zig-native', // the build template c-cpp-zig-build syncs in
  'compile_commands.json', // for clangd
  '.uncached-build', // the second output dir check-turbo-cache.mjs builds into
]

/*
 * At the root, only the cache — not all of `.turbo`.
 *
 * `.turbo/daemon` holds the turbo daemon's own log files, which on Windows it
 * keeps open: removing them fails with EPERM or ENOTEMPTY and takes the whole
 * script down. They are also irrelevant here. `.turbo/cache` is what decides
 * whether the next run is a cache hit.
 */
const AT_ROOT = ['.turbo/cache']

/**
 * The globs declared in package.json, in either shape npm and Yarn accept: an
 * array, or an object with them under `packages`.
 *
 * Anything else is refused before a single file is removed. A script whose job
 * is deleting things should not guess at what it was pointed at — and the
 * failure this replaces was `patterns is not iterable`, several frames deep.
 */
function workspacePatterns() {
  const { workspaces: declared } = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  )
  const patterns = Array.isArray(declared) ? declared : declared?.packages
  if (!Array.isArray(patterns)) {
    process.stderr.write(
      'package.json declares no usable "workspaces": expected an array of globs, or an ' +
        `object with a "packages" array, and found ${JSON.stringify(declared)}\n`,
    )
    process.exit(1)
  }
  return patterns
}

/** The workspace directories those globs expand to. */
function workspaces() {
  const found = []
  for (const pattern of workspacePatterns()) {
    if (!pattern.endsWith('/*')) {
      found.push(pattern)
      continue
    }
    const parent = path.join(root, pattern.slice(0, -2))
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        found.push(path.join(pattern.slice(0, -2), entry.name))
      }
    }
  }
  return found
}

const removed = []
const failed = []

function remove(relative, absolute = path.join(root, relative)) {
  if (!fs.existsSync(absolute)) {
    return
  }
  try {
    // maxRetries is for Windows, where a virus scanner or an editor can hold a
    // handle open for a moment after the process that made it has gone.
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    removed.push(relative)
  } catch (error) {
    failed.push({ relative, message: error.message })
  }
}

// Resolved before anything is removed, so a malformed manifest stops the run
// rather than half-clearing it.
const workspaceDirs = workspaces()

for (const workspace of workspaceDirs) {
  for (const target of PER_WORKSPACE) {
    remove(path.join(workspace, target))
  }
}
for (const target of AT_ROOT) {
  remove(target)
}

if (process.argv.includes('--toolchain')) {
  // Shared with every other project on this machine, which is why it takes a
  // flag: without it the next build reuses the toolchain and the download —
  // the slow, interesting part — never happens again.
  const home = process.env.C_CPP_ZIG_BUILD_HOME || path.join(os.homedir(), '.zig-build')
  const zig = path.join(home, 'zig')
  remove(zig, zig)
}

for (const entry of removed) {
  process.stdout.write(`removed ${entry}\n`)
}

if (failed.length > 0) {
  for (const { relative, message } of failed) {
    process.stderr.write(`could not remove ${relative}: ${message}\n`)
  }
  process.stderr.write(
    '\nEverything else was removed. On Windows this usually means a file is\n' +
      'still open: `turbo daemon stop` releases the ones turbo owns, and an\n' +
      'editor or a shell sitting in the directory holds the rest.\n',
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    removed.length === 0
      ? 'nothing to remove; this workspace is already cold\n'
      : '\nready — the next `bun run build` will be a cache miss\n',
  )
}
