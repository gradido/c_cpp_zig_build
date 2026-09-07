import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ensureDir, isFile } from './fsutil.js'
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
 * A watchdog gives up on a source that is not delivering. This matters because
 * the Zig community mirrors are volunteer-run: at any time some are down, and
 * some answer but then trickle bytes at a few KiB/s. Waiting out the full
 * timeout on one of those looks exactly like a hung build, so a bad source is
 * abandoned in seconds and the caller moves to the next one.
 *
 * @param {string} url
 * @param {string} destination
 * @param {{
 *   sha256?: string,
 *   label?: string,
 *   size?: number,
 *   timeoutMs?: number,
 *   firstByteTimeoutMs?: number,
 *   stallTimeoutMs?: number,
 *   minBytesPerSecond?: number,
 * }} [options]
 */
export async function downloadFile(url, destination, options = {}) {
  const {
    sha256,
    label = path.basename(destination),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    firstByteTimeoutMs = 15_000,
    stallTimeoutMs = 30_000,
    /**
     * A floor, not a target. 64 KiB/s finishes a 50 MB toolchain in thirteen
     * minutes; anything below that is a broken source rather than a slow
     * connection, and is only judged after the grace period below.
     */
    minBytesPerSecond = 64 * 1024,
  } = options

  ensureDir(path.dirname(destination))
  const temp = `${destination}.${process.pid}.part`

  const controller = new AbortController()
  const started = Date.now()
  let received = 0
  let lastChunkAt = started
  let abortReason

  // Throughput is only meaningful once a connection has settled, and a small
  // file may legitimately finish before it does.
  const graceMs = Math.max(stallTimeoutMs, 20_000)

  const watchdog = setInterval(() => {
    const now = Date.now()
    const elapsed = now - started
    if (received === 0) {
      if (elapsed > firstByteTimeoutMs) {
        abortReason = `no data after ${Math.round(firstByteTimeoutMs / 1000)}s`
      }
    } else if (now - lastChunkAt > stallTimeoutMs) {
      abortReason = `stalled for ${Math.round((now - lastChunkAt) / 1000)}s`
    } else if (elapsed > graceMs) {
      const rate = received / (elapsed / 1000)
      if (rate < minBytesPerSecond) {
        abortReason = `only ${Math.round(rate / 1024)} KiB/s`
      }
    }
    if (!abortReason && elapsed > timeoutMs) {
      abortReason = `timed out after ${Math.round(timeoutMs / 1000)}s`
    }
    if (abortReason) {
      controller.abort()
    }
  }, 1000)
  // The interval must not be what keeps the process alive.
  watchdog.unref?.()

  // Created once the response headers say how big the file is.
  let bar
  const hash = createHash('sha256')

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) {
      throw new Error(`${response.status} ${response.statusText}`)
    }

    // A caller that knows the size wins over the header: not every community
    // mirror sends `Content-Length`, and one that serves the archive chunked or
    // gzipped either omits it or reports the encoded length. Without a total,
    // the progress bar degrades to counting megabytes.
    const total = options.size || Number(response.headers.get('content-length') ?? 0)
    bar = makeProgress(label, total)

    const source = Readable.fromWeb(response.body)
    source.on('data', (chunk) => {
      received += chunk.length
      lastChunkAt = Date.now()
      hash.update(chunk)
      bar.update(received)
    })

    await pipeline(source, fs.createWriteStream(temp), { signal: controller.signal })
  } catch (err) {
    await fsp.rm(temp, { force: true })
    // Every failure names the source it came from: with several mirrors in
    // play, "fetch failed" on its own says nothing about which one to blame.
    const reason = abortReason ? `giving up, ${abortReason}` : err.message
    throw new Error(`${url}: ${reason}`, { cause: err })
  } finally {
    clearInterval(watchdog)
    bar?.finish(received)
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
 * Decides how to unpack an archive, given what the machine actually has.
 *
 * Two facts drive this, both of them Windows facts:
 *
 *   * **GNU tar cannot read a zip at all.** Windows 10 1803 and later ship
 *     bsdtar as `tar.exe`, which can — but a Git Bash or MSYS2 shell puts its
 *     own GNU tar ahead of it on `PATH`, and that is the `tar` a build finds.
 *   * **GNU tar reads `C:\...` as `host:path`**, the old rsh syntax, and tries
 *     to open a network connection: `tar: Cannot connect to C: resolve failed`.
 *     `--force-local` turns that off. bsdtar neither needs the flag nor
 *     accepts it.
 *
 * So the flavour of `tar` has to be established before it is trusted with
 * either. Separated from the doing so the combinations can be tested on any
 * platform.
 *
 * @param {{
 *   archive: string,
 *   flavour: 'bsdtar' | 'gnu' | 'none',
 *   systemTar?: string,
 *   windows: boolean,
 * }} machine
 * @returns {{ kind: 'tar', exe: string, forceLocal: boolean } | { kind: 'expand-archive' } | { kind: 'none' }}
 */
export function chooseExtractor({ archive, flavour, systemTar, windows }) {
  if (archive.endsWith('.zip')) {
    if (flavour === 'bsdtar') {
      return { kind: 'tar', exe: 'tar', forceLocal: false }
    }
    // Reaching past the GNU tar on PATH to the bsdtar Windows ships is worth
    // it: Expand-Archive works but takes minutes on a toolchain-sized zip.
    if (systemTar) {
      return { kind: 'tar', exe: systemTar, forceLocal: false }
    }
    return windows ? { kind: 'expand-archive' } : { kind: 'none' }
  }

  if (flavour !== 'none') {
    return { kind: 'tar', exe: 'tar', forceLocal: windows && flavour === 'gnu' }
  }
  if (systemTar) {
    return { kind: 'tar', exe: systemTar, forceLocal: false }
  }
  return { kind: 'none' }
}

/**
 * Extracts a `.tar.xz`, `.tar.gz` or `.zip` archive into `destination`,
 * removing the single top-level directory the archive carries.
 *
 * @param {string} archive
 * @param {string} destination
 * @param {{ stripComponents?: number }} [options]
 */
export async function extractArchive(archive, destination, options = {}) {
  const strip = options.stripComponents ?? 1
  ensureDir(destination)

  const plan = chooseExtractor({
    archive,
    flavour: await tarFlavour(),
    systemTar: systemBsdtar(),
    windows: isWindows(),
  })

  if (plan.kind === 'tar') {
    const flags = archive.endsWith('.tar.xz')
      ? ['-xJf']
      : archive.endsWith('.tar.gz') || archive.endsWith('.tgz')
        ? ['-xzf']
        : ['-xf']
    const args = [...flags, archive, '-C', destination]
    if (strip > 0) {
      args.push(`--strip-components=${strip}`)
    }
    if (plan.forceLocal) {
      args.push('--force-local')
    }
    await run(plan.exe, args, { log: rootLog })
    return destination
  }

  if (plan.kind === 'expand-archive') {
    // Minutes, not seconds, on a toolchain-sized archive — worth saying so
    // rather than letting it look like a hang.
    rootLog.step('no bsdtar here, unpacking with PowerShell instead; this is slow')
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
    `cannot extract ${archive}: no program on this machine can read it. ` +
      (archive.endsWith('.zip')
        ? 'The `tar` on PATH is GNU tar, which cannot read zip files, and no bsdtar was ' +
          'found. On Windows that means Windows 10 1803 or later; elsewhere, install ' +
          "libarchive's bsdtar."
        : 'Install `tar` and try again.'),
  )
}

/** The bsdtar that Windows 10 1803 and later ship, if this is such a machine. */
function systemBsdtar() {
  if (!isWindows()) {
    return undefined
  }
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const exe = path.join(root, 'System32', 'tar.exe')
  return isFile(exe) ? exe : undefined
}

let tarProbe
/**
 * Which `tar` is on PATH. bsdtar identifies itself as `bsdtar 3.7.2 -
 * libarchive 3.7.2`; GNU tar as `tar (GNU tar) 1.35`.
 *
 * @returns {Promise<'bsdtar' | 'gnu' | 'none'>}
 */
async function tarFlavour() {
  if (tarProbe !== undefined) {
    return tarProbe
  }
  const { code, stdout } = await capture('tar', ['--version'])
  tarProbe = code !== 0 ? 'none' : /bsdtar|libarchive/i.test(stdout) ? 'bsdtar' : 'gnu'
  return tarProbe
}

/**
 * Runs `work` while holding a crude directory lock, so two package managers
 * building in parallel do not download the same toolchain twice.
 *
 * The hard part is not the locking, it is the leftovers. `finally` does not run
 * when a build is killed with Ctrl+C, so an interrupted download leaves its
 * lock behind — and a lock that is merely waited on is indistinguishable from a
 * hang: no output, no CPU, for as long as the timeout lasts. So:
 *
 *   * the lock records the pid that holds it, and a lock whose owner is no
 *     longer running is taken over at once rather than waited on;
 *   * an age limit still covers the case where that pid has been reused;
 *   * waiting is announced, with the path to delete if the answer is wrong; and
 *   * SIGINT and SIGTERM remove the lock on the way out.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} work
 * @param {{ log?: import('./log.js').Logger, timeoutMs?: number, staleAfterMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, work, options = {}) {
  const log = options.log ?? rootLog
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000)
  ensureDir(path.dirname(lockPath))

  let announced = false
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
      const owner = await lockOwner(lockPath)
      if (!owner || owner.ageMs > staleAfterMs || !processAlive(owner.pid)) {
        log.debug(`taking over the lock left by pid ${owner?.pid ?? 'an unknown process'}`)
        await fsp.rm(lockPath, { force: true })
        continue
      }
      if (!announced) {
        announced = true
        log.step(
          `waiting for another build (pid ${owner.pid}) to finish; ` +
            `delete ${lockPath} if there is none`,
        )
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock ${lockPath}; delete it if no build is running`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const release = () => {
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      // Nothing useful to do on the way out.
    }
  }
  const onSignal = () => {
    release()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    return await work()
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await fsp.rm(lockPath, { force: true })
  }
}

/** The pid written into a lock file, and how long ago it was created. */
async function lockOwner(lockPath) {
  try {
    const text = await fsp.readFile(lockPath, 'utf8')
    const stat = await fsp.stat(lockPath)
    return { pid: Number.parseInt(text.trim(), 10), ageMs: Date.now() - stat.mtimeMs }
  } catch {
    return undefined
  }
}

/** True when a process with this id is still running. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return err.code === 'EPERM'
  }
}
