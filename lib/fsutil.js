import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** @param {string} p */
export function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/** @param {string} p */
export function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} p */
export function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** @param {string} p */
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** @param {string} p */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** Reads a JSON file, returning undefined rather than throwing when absent. */
export function tryReadJson(p) {
  try {
    return readJson(p)
  } catch {
    return undefined
  }
}

/**
 * Copies a directory tree, skipping files whose content is already identical.
 *
 * Used to refresh the Zig template inside a consuming project: leaving
 * unchanged files alone keeps their mtimes stable, which keeps Zig's build
 * cache warm across runs.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<number>} number of files actually written
 */
export async function syncDir(from, to) {
  let written = 0
  await fsp.mkdir(to, { recursive: true })
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) {
      written += await syncDir(src, dst)
    } else if (entry.isFile()) {
      const next = await fsp.readFile(src)
      let same = false
      try {
        same = Buffer.compare(await fsp.readFile(dst), next) === 0
      } catch {
        same = false
      }
      if (!same) {
        await fsp.writeFile(dst, next)
        written++
      }
    }
  }
  return written
}

/** @param {string} p */
export async function removeDir(p) {
  await fsp.rm(p, { recursive: true, force: true })
}

/**
 * Deletes a file, ignoring failure.
 *
 * For cleanup that is worth attempting and never worth failing a build over:
 * a downloaded archive that has already been unpacked, for instance.
 *
 * @param {string} p
 */
export async function removeQuietly(p) {
  try {
    await fsp.rm(p, { force: true })
  } catch {
    // Leaving the file behind costs disk space and nothing else.
  }
}

/**
 * Turns an arbitrary package name into something usable as a C identifier and
 * as a Zig artifact name: `@scope/my-addon` becomes `my_addon`.
 *
 * @param {string} name
 */
export function toIdentifier(name) {
  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || 'native'
}
