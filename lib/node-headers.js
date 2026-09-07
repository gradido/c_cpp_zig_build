import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { isDirectory, isFile } from './fsutil.js'

/**
 * Returns the directory holding `node_api.h`.
 *
 * The `node-api-headers` package is the source. It is a dependency of this
 * one, so it is always there, it is versioned by npm rather than by whichever
 * Node happens to be running, and nothing has to be downloaded or unpacked to
 * get at it.
 *
 * That set is deliberately just the Node-API: `node_api.h`, `js_native_api.h`
 * and their `_types` headers. `v8.h`, `node.h` and `uv.h` are not in it. An
 * addon that reaches for V8 directly is pinned to one Node build in a way
 * Node-API exists to avoid — but if you need them anyway, point `nodeHeaders`
 * at a directory that has them and this step steps aside.
 *
 * @param {{ root?: string, nodeHeaders?: string }} config
 * @returns {{ includeDir: string, source: string }}
 */
export function resolveNodeHeaders(config = {}) {
  const root = config.root ?? process.cwd()

  // An explicit directory wins outright: it is the escape hatch for the full
  // header set, and for header sets this tool knows nothing about.
  if (config.nodeHeaders) {
    const dir = path.resolve(root, config.nodeHeaders)
    if (!isDirectory(dir)) {
      throw new Error(`nodeHeaders points at a missing directory: ${dir}`)
    }
    if (!isFile(path.join(dir, 'node_api.h'))) {
      throw new Error(`nodeHeaders points at a directory with no node_api.h in it: ${dir}`)
    }
    return { includeDir: dir, source: 'configured' }
  }

  const pkg = resolveNodeApiHeaders(root)
  if (!pkg) {
    throw new Error(
      '`node-api-headers` could not be resolved, so there are no Node-API headers to compile ' +
        'against. It ships as a dependency of this package, so this usually means a broken ' +
        'install: reinstall, or add `node-api-headers` to the project and try again.',
    )
  }
  return { includeDir: pkg.includeDir, source: `node-api-headers ${pkg.version}` }
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
 * Finds `node-api-headers`: the Node-API headers every addon here compiles
 * against, and the Windows `.def` files, which are the only route to an import
 * library for Bun.
 *
 * @param {string} root
 */
export function resolveNodeApiHeaders(root) {
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
