/*
 * The reason this package exists: its build step *calls the addon*.
 *
 * turbo runs it only after `@turbo-example/checksum#build`, because turbo.json
 * says `dependsOn: ["^build"]`. If the compiled `.node` file were not there —
 * because the upstream task was a cache hit and its outputs were not restored
 * — this script would not merely produce a stale manifest, it would fail to
 * import. That is the check, and it runs on every build.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import checksum from '@turbo-example/checksum'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, 'index.mjs'))
const crc32 = checksum.crc32(source)

fs.mkdirSync(path.join(here, 'dist'), { recursive: true })
fs.writeFileSync(
  path.join(here, 'dist', 'manifest.json'),
  `${JSON.stringify({ file: 'index.mjs', bytes: source.length, crc32 }, null, 2)}\n`,
)

process.stdout.write(`wrote dist/manifest.json — index.mjs crc32 ${crc32.toString(16)}\n`)
