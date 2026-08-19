#!/usr/bin/env node
/**
 * Builds every example and runs its tests.
 *
 * The examples are the real integration test for this package: they exercise
 * the template, the downloads, both languages, vendored sources and a Zig
 * package dependency. The unit tests in tests/ cannot cover any of that.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const examples = fs
  .readdirSync(path.join(root, 'examples'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'examples', entry.name))
  .sort()

let failed = 0

for (const example of examples) {
  const name = path.basename(example)
  process.stdout.write(`\n=== ${name} ===\n`)

  // node-addon-api is a devDependency of the example that needs it.
  if (fs.existsSync(path.join(example, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(example, 'package.json'), 'utf8'))
    const needsInstall =
      Object.keys(pkg.devDependencies ?? {}).length > 0 &&
      !fs.existsSync(path.join(example, 'node_modules'))
    if (needsInstall) {
      process.stdout.write('installing devDependencies\n')
      const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: example,
        stdio: 'inherit',
      })
      if (install.status !== 0) {
        failed++
        continue
      }
    }
  }

  const build = spawnSync(process.execPath, [path.join(root, 'lib', 'cli.js'), 'build'], {
    cwd: example,
    stdio: 'inherit',
  })
  if (build.status !== 0) {
    failed++
    continue
  }

  if (fs.existsSync(path.join(example, 'test.mjs'))) {
    const test = spawnSync(process.execPath, ['--test'], { cwd: example, stdio: 'inherit' })
    if (test.status !== 0) {
      failed++
    }
  }
}

process.stdout.write(
  failed === 0 ? `\nall ${examples.length} examples passed\n` : `\n${failed} example(s) failed\n`,
)
process.exitCode = failed === 0 ? 0 : 1
