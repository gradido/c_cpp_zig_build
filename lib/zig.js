import fsp from 'node:fs/promises'
import path from 'node:path'

import { downloadFile, extractArchive, fetchJson, fetchText, withLock } from './download.js'
import { ensureDir, exists, isFile, removeDir, removeQuietly } from './fsutil.js'
import { cacheHome, isWindows, zigHostKey } from './host.js'
import { rootLog } from './log.js'
import { capture } from './proc.js'

/** The Zig release this package is written against. */
export const DEFAULT_ZIG_VERSION = '0.15.2'

const INDEX_URL = 'https://ziglang.org/download/index.json'
const MIRRORS_URL = 'https://ziglang.org/download/community-mirrors.txt'

/** Where a given Zig version is unpacked. */
export function zigInstallDir(version) {
  return path.join(cacheHome(), 'zig', version)
}

/** The Zig binary inside an install directory. */
export function zigBinaryPath(version) {
  return path.join(zigInstallDir(version), isWindows() ? 'zig.exe' : 'zig')
}

/**
 * Returns the path to a usable `zig`, downloading the toolchain if needed.
 *
 * Resolution order, first hit wins:
 *   1. `options.zigExe`, or the `ZIG_EXE` environment variable
 *   2. a `zig` already on PATH, but only when `options.useSystemZig` is set
 *      and its version matches the one asked for
 *   3. `~/.zig-build/zig/<version>/zig`, downloaded on first use
 *
 * @param {{
 *   version?: string,
 *   zigExe?: string,
 *   useSystemZig?: boolean,
 *   log?: import('./log.js').Logger,
 *   offline?: boolean,
 * }} [options]
 * @returns {Promise<{ exe: string, version: string, source: 'explicit' | 'system' | 'download' }>}
 */
export async function resolveZig(options = {}) {
  const version = options.version ?? DEFAULT_ZIG_VERSION
  const log = options.log ?? rootLog

  const explicit = options.zigExe ?? process.env.ZIG_EXE
  if (explicit) {
    if (!isFile(explicit)) {
      throw new Error(`zigExe points at a missing file: ${explicit}`)
    }
    const found = await zigVersionOf(explicit)
    log.debug(`using zig from configuration: ${explicit} (${found ?? 'unknown version'})`)
    return { exe: explicit, version: found ?? version, source: 'explicit' }
  }

  if (options.useSystemZig) {
    const system = await findSystemZig(version)
    if (system) {
      log.debug(`using zig from PATH: ${system.exe} (${system.version})`)
      return { ...system, source: 'system' }
    }
    log.debug(`no zig ${version} on PATH; falling back to the managed toolchain`)
  }

  const exe = zigBinaryPath(version)
  if (isFile(exe)) {
    return { exe, version, source: 'download' }
  }
  if (options.offline) {
    throw new Error(
      `zig ${version} is not installed at ${exe} and downloads are disabled (offline). ` +
        'Run once with network access, or point `zigExe` at an existing toolchain.',
    )
  }

  await withLock(path.join(cacheHome(), 'zig', `.${version}.lock`), async () => {
    // Another process may have finished while we waited for the lock.
    if (isFile(exe)) {
      return
    }
    await installZig(version, log)
  })

  if (!isFile(exe)) {
    throw new Error(`zig ${version} was downloaded but ${exe} is missing`)
  }
  return { exe, version, source: 'download' }
}

/**
 * Downloads and unpacks one Zig release.
 *
 * The checksum always comes from ziglang.org's own index, even when the
 * tarball itself is fetched from a community mirror — that is what makes
 * mirrors safe to use.
 *
 * @param {string} version
 * @param {import('./log.js').Logger} log
 */
async function installZig(version, log) {
  const target = zigInstallDir(version)
  const key = zigHostKey()

  log.step(`downloading Zig ${version} for ${key} (this happens once)`)

  const index = await fetchJson(INDEX_URL)
  const release = index[version]
  if (!release) {
    const known = Object.keys(index)
      .filter((k) => /^\d/.test(k))
      .slice(0, 10)
      .join(', ')
    throw new Error(`ziglang.org does not list Zig ${version}. Recent releases: ${known}`)
  }
  const build = release[key]
  if (!build?.tarball) {
    throw new Error(`Zig ${version} has no build for ${key}`)
  }

  const filename = path.basename(new URL(build.tarball).pathname)
  const archive = path.join(cacheHome(), 'zig', 'downloads', filename)

  if (!exists(archive)) {
    const urls = await downloadCandidates(build.tarball, filename, version, log)
    let lastError
    for (const url of urls) {
      try {
        await downloadFile(url, archive, { sha256: build.shasum, label: filename })
        lastError = undefined
        break
      } catch (err) {
        lastError = err
        log.warn(`${url}: ${err.message}`)
      }
    }
    if (lastError) {
      throw lastError
    }
  }

  // Unpack into a staging directory first: a half-extracted toolchain that
  // happens to contain a `zig` binary would otherwise be treated as installed.
  const staging = `${target}.staging`
  await removeDir(staging)
  ensureDir(staging)
  await extractArchive(archive, staging, { stripComponents: 1 })
  await removeDir(target)
  ensureDir(path.dirname(target))
  await fsp.rename(staging, target)

  if (!isWindows()) {
    await fsp.chmod(path.join(target, 'zig'), 0o755).catch(() => {
      // The archive normally carries the executable bit already; a filesystem
      // that will not let us set it is not a reason to fail the install.
    })
  }
  // The archive is 50-90 MB and serves no purpose once unpacked.
  await removeQuietly(archive)

  log.step(`Zig ${version} installed in ${target}`)
}

/**
 * The URLs to try, in order: the mirror named by ZIG_MIRROR if any, then
 * ziglang.org itself.
 *
 * Zig's maintainers ask that automated tooling prefer the community mirrors
 * over ziglang.org, so a mirror is used first whenever the list is reachable.
 */
async function downloadCandidates(officialUrl, filename, version, log) {
  const urls = []
  if (process.env.ZIG_MIRROR) {
    urls.push(joinUrl(process.env.ZIG_MIRROR, filename))
  }
  try {
    const listed = (await fetchText(MIRRORS_URL, { timeoutMs: 10_000 }))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    if (listed.length > 0) {
      // Spread load across mirrors rather than hammering the first one.
      const pick = listed[Math.floor(Math.random() * listed.length)]
      urls.push(joinUrl(pick, filename))
    }
  } catch (err) {
    log.debug(`community mirror list unavailable: ${err.message}`)
  }
  urls.push(officialUrl)
  return [...new Set(urls)]
}

function joinUrl(base, filename) {
  return `${base.replace(/\/+$/, '')}/${filename}`
}

/** @param {string} exe */
async function zigVersionOf(exe) {
  const { code, stdout } = await capture(exe, ['version'])
  return code === 0 ? stdout.trim() : undefined
}

async function findSystemZig(wanted) {
  const exe = isWindows() ? 'zig.exe' : 'zig'
  const version = await zigVersionOf(exe)
  if (!version) {
    return undefined
  }
  if (wanted && version !== wanted) {
    return undefined
  }
  return { exe, version }
}

/** Lists the Zig versions this machine has already downloaded. */
export async function installedZigVersions() {
  try {
    const entries = await fsp.readdir(path.join(cacheHome(), 'zig'), { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && /^\d/.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
