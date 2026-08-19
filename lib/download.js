import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ensureDir, exists } from './fsutil.js'
import { isWindows } from './host.js'
import { makeProgress, rootLog } from './log.js'
import { capture, run } from './proc.js'

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Fetches a URL as JSON.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 */
export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options.timeoutMs ?? 60_000)
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

/**
 * Fetches a URL as text.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 */
export async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options.timeoutMs ?? 60_000)
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Downloads a file to disk, showing progress and verifying its SHA-256.
 *
 * The download lands on a temporary name and is renamed into place only after
 * the checksum matches, so an interrupted run never leaves a half-written file
 * that a later run would mistake for a complete one.
 *
 * @param {string} url
 * @param {string} destination
 * @param {{ sha256?: string, label?: string, timeoutMs?: number }} [options]
 */
export async function downloadFile(url, destination, options = {}) {
  const { sha256, label = path.basename(destination) } = options
  ensureDir(path.dirname(destination))
  const temp = `${destination}.${process.pid}.part`

  const response = await fetchWithTimeout(url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  const progress = makeProgress(label, total)
  const hash = createHash('sha256')
  let received = 0

  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    hash.update(chunk)
    progress.update(received)
  })

  try {
    await pipeline(source, fs.createWriteStream(temp))
  } finally {
    progress.finish()
  }

  if (sha256) {
    const actual = hash.digest('hex')
    if (actual !== sha256) {
      await fsp.rm(temp, { force: true })
      throw new Error(
        `checksum mismatch for ${url}\n  expected sha256 ${sha256}\n  actual   sha256 ${actual}`,
      )
    }
  }

  await fsp.rename(temp, destination)
  return destination
}

/**
 * Extracts a `.tar.xz`, `.tar.gz` or `.zip` archive into `destination`,
 * removing the single top-level directory the archive carries.
 *
 * `tar` is used everywhere: it has shipped with Windows 10 1803 and later as
 * bsdtar, which reads zip files too. PowerShell's Expand-Archive is the
 * fallback for older Windows installs.
 *
 * @param {string} archive
 * @param {string} destination
 * @param {{ stripComponents?: number }} [options]
 */
export async function extractArchive(archive, destination, options = {}) {
  const strip = options.stripComponents ?? 1
  ensureDir(destination)

  const isZip = archive.endsWith('.zip')
  const haveTar = await hasTar()

  if (haveTar) {
    const flags = archive.endsWith('.tar.xz')
      ? ['-xJf']
      : archive.endsWith('.tar.gz') || archive.endsWith('.tgz')
        ? ['-xzf']
        : ['-xf']
    const args = [...flags, archive, '-C', destination]
    if (strip > 0) {
      args.push(`--strip-components=${strip}`)
    }
    await run('tar', args, { log: rootLog })
    return destination
  }

  if (isZip && isWindows()) {
    const staging = `${destination}.staging`
    await fsp.rm(staging, { recursive: true, force: true })
    ensureDir(staging)
    await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Path '${archive}' -DestinationPath '${staging}' -Force`,
      ],
      { log: rootLog },
    )
    let source = staging
    for (let i = 0; i < strip; i++) {
      const entries = await fsp.readdir(source, { withFileTypes: true })
      const only = entries.length === 1 && entries[0].isDirectory() ? entries[0].name : undefined
      if (!only) {
        break
      }
      source = path.join(source, only)
    }
    for (const entry of await fsp.readdir(source)) {
      await fsp.rename(path.join(source, entry), path.join(destination, entry))
    }
    await fsp.rm(staging, { recursive: true, force: true })
    return destination
  }

  throw new Error(
    `cannot extract ${archive}: no usable 'tar' was found on PATH. ` +
      'Install tar (or use Windows 10 1803+) and try again.',
  )
}

let tarProbe
async function hasTar() {
  if (tarProbe !== undefined) {
    return tarProbe
  }
  const { code } = await capture('tar', ['--version'])
  tarProbe = code === 0
  return tarProbe
}

/**
 * Runs `work` while holding a crude directory lock, so two package managers
 * building in parallel do not download the same toolchain twice.
 *
 * The lock is advisory and self-healing: a lock older than ten minutes is
 * assumed to belong to a crashed process and is taken over.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, work) {
  ensureDir(path.dirname(lockPath))
  const deadline = Date.now() + 10 * 60 * 1000

  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      break
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err
      }
      let stale = false
      try {
        const stat = await fsp.stat(lockPath)
        stale = Date.now() - stat.mtimeMs > 10 * 60 * 1000
      } catch {
        stale = true
      }
      if (stale) {
        await fsp.rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock ${lockPath}; delete it if no build is running`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  try {
    return await work()
  } finally {
    await fsp.rm(lockPath, { force: true })
  }
}
