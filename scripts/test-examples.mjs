#!/usr/bin/env node
/**
 * Builds every example and runs its tests.
 *
 * The examples are the real integration test for this package: they exercise
 * the template, the downloads, both languages, vendored sources, a Zig package
 * dependency and a turborepo. The unit tests in tests/ cannot cover any of
 * that.
 *
 * Each example is driven through its own `build` and `test` scripts rather
 * than by calling the CLI directly, so this runs exactly what the README tells
 * a reader to type — and so an example that is not a single project, like the
 * turborepo, needs no special case here.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const examples = fs
  .readdirSync(path.join(root, 'examples'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'examples', entry.name))
  .sort()

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies']

/** Runs one npm script in an example, returning true when it succeeded. */
function npmRun(example, args) {
  return spawnSync(npm, args, { cwd: example, stdio: 'inherit' }).status === 0
}

let failed = 0

for (const example of examples) {
  const name = path.basename(example)
  process.stdout.write(`\n=== ${name} ===\n`)

  const manifest = path.join(example, 'package.json')
  if (!fs.existsSync(manifest)) {
    process.stdout.write('no package.json; skipped\n')
    continue
  }
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))

  // Examples that declare dependencies of their own — node-addon-api for the
  // C++ one, turbo for the monorepo — need them on disk first.
  const declaresDependencies = DEPENDENCY_FIELDS.some(
    (field) => Object.keys(pkg[field] ?? {}).length > 0,
  )
  if (declaresDependencies && !fs.existsSync(path.join(example, 'node_modules'))) {
    process.stdout.write('installing dependencies\n')
    if (!npmRun(example, ['install', '--no-audit', '--no-fund'])) {
      failed++
      continue
    }
  }

  if (!npmRun(example, ['run', 'build'])) {
    failed++
    continue
  }

  if (pkg.scripts?.test && !npmRun(example, ['test'])) {
    failed++
  }
}

process.stdout.write(
  failed === 0 ? `\nall ${examples.length} examples passed\n` : `\n${failed} example(s) failed\n`,
)
process.exitCode = failed === 0 ? 0 : 1
