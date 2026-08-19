import fsp from 'node:fs/promises'
import path from 'node:path'

import { downloadFile, extractArchive, fetchJson, fetchText, withLock } from './download.js'
import { ensureDir, exists, isFile, removeDir, removeQuietly } from './fsutil.js'
import { cacheHome, isWindows, zigHostKey } from './host.js'
import { rootLog } from './log.js'
import { hashFile, verifyFile, ZIG_PUBLIC_KEY } from './minisign.js'
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
 *   verifySignature?: boolean,
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
    await installZig(version, log, options.verifySignature !== false)
  })

  if (!isFile(exe)) {
    throw new Error(`zig ${version} was downloaded but ${exe} is missing`)
  }
  return { exe, version, source: 'download' }
}

/**
 * Downloads and unpacks one Zig release.
 *
 * The archive is checked twice, in two independent ways, before anything is
 * unpacked:
 *
 *   * against the SHA-256 published in ziglang.org's index, which says "this
 *     is the file ziglang.org listed"; and
 *   * against the Zig project's minisign signature, which says "this file was
 *     signed by the Zig project" — and which a mirror cannot forge.
 *
 * The second is what makes downloading from a community mirror safe, and Zig
 * asks tooling to prefer the mirrors.
 *
 * @param {string} version
 * @param {import('./log.js').Logger} log
 * @param {boolean} checkSignature
 */
async function installZig(version, log, checkSignature) {
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

  // The signature is fetched before the archive: it is a few hundred bytes,
  // and there is no point spending 50 MB of bandwidth on something that
  // cannot be checked afterwards.
  const signature = checkSignature ? await fetchSignature(build.tarball, version, log) : undefined

  if (exists(archive)) {
    // A leftover from an interrupted run. `downloadFile` checks the digest as
    // it streams, so a fresh download is already covered; a cached file has
    // never been checked by this process and must not be trusted on the
    // strength of its file name.
    const actual = (await hashFile(archive, 'sha256')).toString('hex')
    if (actual !== build.shasum) {
      log.warn(`the cached ${filename} does not match its published checksum; downloading again`)
      await removeQuietly(archive)
    }
  }

  if (!exists(archive)) {
    const urls = await downloadCandidates(build.tarball, filename, version, log)
    let lastError
    for (const url of urls) {
      try {
        await downloadFile(url, archive, { sha256: build.shasum, label: filename })
        lastError = undefined
        break
      } catch (err) {
        // The message already names the URL it gave up on.
        lastError = err
        log.warn(err.message)
      }
    }
    if (lastError) {
      throw lastError
    }
  }

  if (signature) {
    try {
      const { trustedComment } = await verifyFile(archive, signature, {
        publicKey: ZIG_PUBLIC_KEY,
        expectedFileName: filename,
      })
      log.debug(`minisign signature verified (${trustedComment})`)
    } catch (err) {
      // A file that fails verification must not survive to be picked up by the
      // next run, which would find it cached and skip the download entirely.
      await removeQuietly(archive)
      throw new Error(
        `the Zig ${version} archive failed signature verification: ${err.message}\n` +
          'The download was deleted. This means the file was not the one the Zig ' +
          'project signed — check your network, or try again with ZIG_MIRROR unset.',
        { cause: err },
      )
    }
  } else {
    log.warn('signature verification is disabled; the Zig archive was not verified')
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

/** How many community mirrors to line up before falling back to ziglang.org. */
const MIRROR_ATTEMPTS = 3

/**
 * The URLs to try, in order: `ZIG_MIRROR` if set, then a few community
 * mirrors, then ziglang.org itself.
 *
 * Zig's maintainers ask that automated tooling prefer the community mirrors,
 * so ziglang.org is the last resort rather than the first choice. More than
 * one mirror is queued because they are volunteer-run and a few are always
 * either down or barely moving — with a single pick, a bad draw would send
 * every build straight to the official host, which is the load the mirrors
 * exist to absorb.
 *
 * The order is randomised so that load spreads instead of piling onto whoever
 * happens to be listed first.
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
    for (const mirror of shuffle(listed).slice(0, MIRROR_ATTEMPTS)) {
      urls.push(joinUrl(mirror, filename))
    }
  } catch (err) {
    log.debug(`community mirror list unavailable: ${err.message}`)
  }
  urls.push(officialUrl)
  return [...new Set(urls)]
}

/** Fisher-Yates, so every mirror is equally likely to be tried first. */
function shuffle(items) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function joinUrl(base, filename) {
  return `${base.replace(/\/+$/, '')}/${filename}`
}

/**
 * Fetches the `.minisig` for a release.
 *
 * Always from ziglang.org, never from a mirror: a signature served by the same
 * host as the file it signs proves nothing about the host. The signature is
 * only meaningful because it is checked against a key pinned in this package,
 * and fetching it from the canonical source keeps a broken or hostile mirror
 * from being able to withhold it.
 */
async function fetchSignature(tarballUrl, version, log) {
  const url = `${tarballUrl}.minisig`
  try {
    return await fetchText(url, { timeoutMs: 30_000 })
  } catch (err) {
    throw new Error(
      `could not fetch the signature for Zig ${version} from ${url}: ${err.message}\n` +
        'Pass --no-verify-signature to install without it, at your own risk.',
      { cause: err },
    )
  } finally {
    log.debug(`signature source: ${url}`)
  }
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
