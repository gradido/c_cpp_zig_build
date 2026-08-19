import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { downloadFile, extractArchive, fetchText, withLock } from './download.js'
import { ensureDir, exists, isDirectory, isFile, removeDir, removeQuietly } from './fsutil.js'
import { cacheHome, nodeWindowsArch } from './host.js'
import { rootLog } from './log.js'

const NODE_DIST = process.env.NODEJS_ORG_MIRROR || 'https://nodejs.org/download/release'

/** Where the headers for one Node version live once unpacked. */
export function nodeHeadersRoot(version) {
  return path.join(cacheHome(), 'node', `v${version}`)
}

/**
 * Returns the directory holding `node_api.h` for the requested Node version,
 * downloading the official header tarball on first use.
 *
 * The full header set is used rather than the `node-api-headers` package
 * because it also carries `v8.h`, `uv.h` and `node.h`: a C addon needs only
 * `node_api.h`, but anything reaching for V8 directly needs the rest, and
 * having them costs nothing once cached.
 *
 * @param {{
 *   version: string,
 *   mode?: 'auto' | 'download' | 'package' | string,
 *   root?: string,
 *   log?: import('./log.js').Logger,
 *   offline?: boolean,
 * }} options
 * @returns {Promise<{ includeDir: string, source: string }>}
 */
export async function resolveNodeHeaders(options) {
  const { version, root = process.cwd(), log = rootLog } = options
  const mode = options.mode ?? 'auto'

  // An explicit path wins outright.
  if (mode !== 'auto' && mode !== 'download' && mode !== 'package') {
    const dir = path.resolve(root, mode)
    if (!isDirectory(dir)) {
      throw new Error(`nodeHeaders points at a missing directory: ${dir}`)
    }
    return { includeDir: dir, source: 'configured' }
  }

  if (mode === 'package') {
    const pkg = resolveNodeApiHeadersPackage(root)
    if (!pkg) {
      throw new Error(
        "nodeHeaders is set to 'package' but `node-api-headers` is not installed. " +
          'Add it as a devDependency, or switch to the default.',
      )
    }
    return { includeDir: pkg.includeDir, source: 'node-api-headers' }
  }

  const includeDir = path.join(nodeHeadersRoot(version), 'include', 'node')
  if (isFile(path.join(includeDir, 'node_api.h'))) {
    return { includeDir, source: `nodejs.org v${version}` }
  }

  if (options.offline) {
    const pkg = resolveNodeApiHeadersPackage(root)
    if (pkg) {
      return { includeDir: pkg.includeDir, source: 'node-api-headers (offline)' }
    }
    throw new Error(`Node headers for v${version} are not cached and downloads are disabled`)
  }

  try {
    await withLock(path.join(cacheHome(), 'node', `.v${version}.lock`), async () => {
      if (isFile(path.join(includeDir, 'node_api.h'))) {
        return
      }
      await downloadNodeHeaders(version, log)
    })
  } catch (err) {
    // A missing network is survivable when the project happens to carry the
    // header package; saying which fallback was taken keeps the build honest.
    const pkg = mode === 'auto' ? resolveNodeApiHeadersPackage(root) : undefined
    if (!pkg) {
      throw err
    }
    log.warn(`could not download Node headers (${err.message}); using node-api-headers instead`)
    return { includeDir: pkg.includeDir, source: 'node-api-headers (fallback)' }
  }

  return { includeDir, source: `nodejs.org v${version}` }
}

/**
 * @param {string} version
 * @param {import('./log.js').Logger} log
 */
async function downloadNodeHeaders(version, log) {
  const name = `node-v${version}-headers.tar.gz`
  const url = `${NODE_DIST}/v${version}/${name}`
  const archive = path.join(cacheHome(), 'node', 'downloads', name)
  const target = nodeHeadersRoot(version)

  log.step(`downloading Node ${version} headers (this happens once per Node version)`)
  const sha256 = await shasumFor(version, name, log)
  await downloadFile(url, archive, { sha256, label: name })

  const staging = `${target}.staging`
  await removeDir(staging)
  ensureDir(staging)
  await extractArchive(archive, staging, { stripComponents: 1 })
  await removeDir(target)
  ensureDir(path.dirname(target))
  await fsp.rename(staging, target)
  // Cleanup only: the headers are unpacked, so the archive is dead weight.
  await removeQuietly(archive)
}

/**
 * The Windows import library, downloaded the same way node-gyp does it.
 *
 * Linking against it is what lets an addon resolve `napi_*` at load time on
 * Windows, where undefined symbols in a DLL are not allowed.
 *
 * @param {{ version: string, triple: string, log?: import('./log.js').Logger }} options
 * @returns {Promise<string>} absolute path to node.lib
 */
export async function resolveNodeLib(options) {
  const { version, triple, log = rootLog } = options
  const archDir = nodeWindowsArch(triple)
  const target = path.join(nodeHeadersRoot(version), archDir, 'node.lib')
  if (isFile(target)) {
    return target
  }

  await withLock(path.join(cacheHome(), 'node', `.v${version}-${archDir}.lock`), async () => {
    if (isFile(target)) {
      return
    }
    const url = `${NODE_DIST}/v${version}/${archDir}/node.lib`
    log.step(`downloading node.lib for ${archDir}`)
    const sha256 = await shasumFor(version, `${archDir}/node.lib`, log)
    await downloadFile(url, target, { sha256, label: `${archDir}/node.lib` })
  })
  return target
}

/**
 * Looks up one entry in a release's SHASUMS256.txt.
 *
 * Verification is best-effort: a mirror that does not publish the file should
 * not stop a build, but the common case gets a real integrity check.
 */
async function shasumFor(version, entry, log) {
  try {
    const text = await fetchText(`${NODE_DIST}/v${version}/SHASUMS256.txt`, { timeoutMs: 30_000 })
    for (const line of text.split('\n')) {
      const [sum, name] = line.trim().split(/\s+/)
      if (name === entry) {
        return sum
      }
    }
  } catch (err) {
    log.debug(`no SHASUMS256.txt for v${version}: ${err.message}`)
  }
  return undefined
}

/**
 * Finds `node-addon-api`, the C++ convenience layer over Node-API.
 *
 * A copy ships with this package, so C++ bindings compile without the project
 * installing anything. A copy in the project wins over it, because the version
 * a project pins is the version its code was written against — and `napi.h`
 * does change between majors.
 *
 * @param {string} root
 * @returns {{ includeDir: string, version: string, declared: boolean } | undefined}
 */
export function resolveNodeAddonApi(root) {
  const found = resolveFromProject(root, 'node-addon-api/package.json')
  if (!found) {
    return undefined
  }
  // node-addon-api's own index.js reports a *relative* include_dir computed
  // against the current working directory, which is wrong for anyone who is
  // not npm. The package directory is the include directory.
  return {
    includeDir: path.dirname(found.path),
    version: readVersion(found.path),
    declared: found.declared,
  }
}

/**
 * Finds `node-api-headers`.
 *
 * This package depends on it for two things a download cannot supply: the
 * Windows `.def` files, which are the only route to an import library for Bun,
 * and a set of headers to fall back on when nodejs.org cannot be reached.
 *
 * @param {string} root
 */
export function resolveNodeApiHeadersPackage(root) {
  const found = resolveFromProject(root, 'node-api-headers/package.json')
  if (!found) {
    return undefined
  }
  const dir = path.dirname(found.path)
  const includeDir = path.join(dir, 'include')
  if (!isDirectory(includeDir)) {
    return undefined
  }
  return {
    includeDir,
    defDir: path.join(dir, 'def'),
    nodeApiDef: path.join(dir, 'def', 'node_api.def'),
    version: readVersion(found.path),
    declared: found.declared,
  }
}

/**
 * Resolves a package from the consuming project first, then from this one.
 *
 * The order matters. In a workspace the dependency lives next to the project,
 * and the version the project pinned is the version its sources were written
 * against; the copy that ships here is the fallback that makes the common case
 * need no setup at all.
 *
 * `declared` says whether the project asked for this package itself, read from
 * its package.json rather than inferred from where the file turned up: npm
 * hoists this package's own dependencies into the consumer's `node_modules`,
 * so the resolved path cannot tell the two apart.
 *
 * @returns {{ path: string, declared: boolean } | undefined}
 */
function resolveFromProject(root, specifier) {
  const name = specifier.split('/')[0]
  const declared = isDeclaredBy(root, name)

  for (const base of [path.join(root, 'package.json'), import.meta.url]) {
    try {
      return { path: createRequire(base).resolve(specifier), declared }
    } catch {
      // Not resolvable from here; try the next base.
    }
  }
  return undefined
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/** True when `root`'s package.json names `packageName` as a dependency. */
function isDeclaredBy(root, packageName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return DEPENDENCY_FIELDS.some((field) => pkg[field]?.[packageName] !== undefined)
  } catch {
    // No readable package.json means nothing is declared.
    return false
  }
}

function readVersion(packageJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
  } catch {
    return 'unknown'
  }
}
