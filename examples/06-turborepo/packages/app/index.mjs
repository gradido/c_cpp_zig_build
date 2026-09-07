import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The manifest written by build.mjs, which is to say: by the addon. */
export function manifest() {
  return JSON.parse(fs.readFileSync(path.join(here, 'dist', 'manifest.json'), 'utf8'))
}
