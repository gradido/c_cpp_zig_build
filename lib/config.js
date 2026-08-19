import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { exists, isDirectory, toIdentifier, tryReadJson } from './fsutil.js'
import { detectHostTriple, detectNodeVersion } from './host.js'
import { DEFAULT_ZIG_VERSION } from './zig.js'

const CONFIG_FILES = [
  'zig-native.config.js',
  'zig-native.config.mjs',
  'zig-native.config.cjs',
  'zig-native.config.json',
]

const OPTIMIZE_ALIASES = {
  debug: 'Debug',
  safe: 'ReleaseSafe',
  fast: 'ReleaseFast',
  small: 'ReleaseSmall',
  Debug: 'Debug',
  ReleaseSafe: 'ReleaseSafe',
  ReleaseFast: 'ReleaseFast',
  ReleaseSmall: 'ReleaseSmall',
}

/**
 * Identity helper for config files, so that editors can type-check them:
 *
 *     import { defineConfig } from 'zig-native-build'
 *     export default defineConfig({ name: 'my_native' })
 *
 * @template T
 * @param {T} config
 * @returns {T}
 */
export function defineConfig(config) {
  return config
}

/**
 * Loads `zig-native.config.*` or the `zigNative` field of package.json.
 *
 * @param {string} root
 * @returns {Promise<object>}
 */
export async function loadConfigFile(root) {
  for (const name of CONFIG_FILES) {
    const file = path.join(root, name)
    if (!exists(file)) {
      continue
    }
    if (name.endsWith('.json')) {
      return tryReadJson(file) ?? {}
    }
    const module = await import(pathToFileURL(file).href)
    const value = module.default ?? module.config ?? module
    return typeof value === 'function' ? await value() : value
  }
  const pkg = tryReadJson(path.join(root, 'package.json'))
  return pkg?.zigNative ?? {}
}

/**
 * Merges defaults, the config file and command line overrides into the single
 * object the rest of the tool works with.
 *
 * Almost every field has a default that is derived from the project, so that a
 * project with the conventional layout needs no configuration at all.
 *
 * @param {object} [overrides]
 * @returns {Promise<object>}
 */
export async function resolveConfig(overrides = {}) {
  const root = path.resolve(overrides.root ?? process.cwd())
  const fromFile = overrides.skipConfigFile ? {} : await loadConfigFile(root)
  const merged = { ...fromFile, ...stripUndefined(overrides) }

  const pkg = tryReadJson(path.join(root, 'package.json'))
  const name = merged.name ?? toIdentifier(pkg?.name ?? path.basename(root))

  const napi = merged.napi ?? 'auto'
  const isAddon = napi === 'auto' ? detectAddon(root) : Boolean(napi)

  const targets = normaliseTargets(merged.targets ?? merged.target, merged)

  return {
    root,
    name,
    packageName: pkg?.name,

    /** Build a Node addon (headers, .node output) rather than a plain library. */
    napi: isAddon,
    napiVersion: merged.napiVersion ?? 8,
    nodeVersion: String(merged.nodeVersion ?? detectNodeVersion(root)).replace(/^v/, ''),
    nodeHeaders: merged.nodeHeaders ?? 'auto',
    /** Build the extra Bun addon on Windows. Auto: whenever bun.exe is around. */
    bun: merged.bun ?? 'auto',

    /** Named targets, each of which becomes one `zig build` invocation. */
    targets,

    optimize: normaliseOptimize(merged.optimize ?? 'ReleaseSmall'),
    buildFile: merged.buildFile ?? 'build.zig',
    outDir: merged.outDir ?? 'build',
    steps: toArray(merged.steps),
    zigOptions: merged.zigOptions ?? {},
    zigArgs: toArray(merged.zigArgs),

    zigVersion: merged.zigVersion ?? DEFAULT_ZIG_VERSION,
    zigExe: merged.zigExe,
    useSystemZig: merged.useSystemZig ?? false,
    offline: merged.offline ?? false,

    templateDir: merged.templateDir ?? '.zig-native',
    cacheDir: merged.cacheDir ?? '.zig-cache',
    /** Shared by default: Zig package downloads are worth reusing across projects. */
    globalCacheDir: merged.globalCacheDir,

    verbose: merged.verbose ?? false,
    env: merged.env ?? {},
  }
}

/**
 * A project builds a Node addon when it has bindings to build. The `napi/`
 * directory is the convention this template documents; the package.json
 * `main` pointing at a `.node` file catches projects that arrange it
 * differently.
 */
function detectAddon(root) {
  if (isDirectory(path.join(root, 'napi'))) {
    return true
  }
  if (isDirectory(path.join(root, 'bindings'))) {
    return true
  }
  const pkg = tryReadJson(path.join(root, 'package.json'))
  const entry = pkg?.main ?? ''
  if (entry.endsWith('.node')) {
    return true
  }
  // An index.cjs that requires the built addon is the usual shape.
  for (const candidate of ['index.cjs', 'index.js', 'index.mjs']) {
    const file = path.join(root, candidate)
    if (!exists(file)) {
      continue
    }
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (/\.node['"]/.test(text)) {
        return true
      }
    } catch {
      // unreadable is not a signal
    }
  }
  return false
}

/**
 * Turns whatever the user wrote for `targets` into a label to config map.
 *
 * Accepted forms:
 *   'x86_64-linux-gnu'                       one target
 *   ['x86_64-linux-gnu', 'aarch64-macos']    several
 *   { linux: { triple: '...', cpu: '...' } } several, named and configured
 */
function normaliseTargets(targets, merged) {
  const shared = { cpu: merged.cpu ?? 'baseline', glibc: merged.glibc, rpath: merged.rpath }

  if (!targets) {
    return { host: { ...shared, triple: undefined } }
  }

  if (typeof targets === 'string') {
    return { [targets]: { ...shared, triple: targets } }
  }
  if (Array.isArray(targets)) {
    return Object.fromEntries(targets.map((t) => [t, { ...shared, triple: t }]))
  }
  return Object.fromEntries(
    Object.entries(targets).map(([label, value]) => [
      label,
      typeof value === 'string'
        ? { ...shared, triple: value }
        : { ...shared, ...value, triple: value.triple ?? label },
    ]),
  )
}

/** Fills in the host triple for any target that did not name one. */
export async function withHostTriple(targets) {
  const host = await detectHostTriple()
  const resolved = {}
  for (const [label, target] of Object.entries(targets)) {
    const triple = target.triple ?? host
    resolved[label === 'host' ? triple : label] = {
      ...target,
      triple: target.glibc ? `${triple}.${target.glibc}` : triple,
      baseTriple: triple,
    }
  }
  return resolved
}

function normaliseOptimize(value) {
  const resolved = OPTIMIZE_ALIASES[value]
  if (!resolved) {
    throw new Error(
      `unknown optimize mode '${value}'. Use one of: ${Object.keys(OPTIMIZE_ALIASES).join(', ')}`,
    )
  }
  return resolved
}

function toArray(value) {
  if (value === undefined || value === null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined))
}
