import path from 'node:path'

import { defineConfig, loadConfigFile, resolveConfig, withHostTriple } from './config.js'
import { exists, removeDir } from './fsutil.js'
import { cacheHome } from './host.js'
import { c, makeLogger, rootLog } from './log.js'
import {
  resolveNodeAddonApi,
  resolveNodeApiHeadersPackage,
  resolveNodeHeaders,
  resolveNodeLib,
} from './node-headers.js'
import { capture, run } from './proc.js'
import { checkZonDependency, syncTemplate } from './template.js'
import { resolveZig } from './zig.js'

export { defineConfig, resolveConfig, loadConfigFile }
export { packagedTemplateDir } from './template.js'
export { DEFAULT_ZIG_VERSION, resolveZig } from './zig.js'

/**
 * Builds the project.
 *
 * Everything the build needs that is not in the project — the Zig toolchain,
 * the Node headers, the Windows import library — is downloaded and cached
 * under `~/.zig-build` before the first compiler runs.
 *
 * @param {object} [overrides] anything accepted by the config file
 * @returns {Promise<{ outputs: string[] }>}
 */
export async function build(overrides = {}) {
  const config = await resolveConfig(overrides)
  const log = makeLogger(config.name, { verbose: config.verbose })

  const toolchain = await prepare(config, log)
  const targets = await withHostTriple(config.targets)
  const labels = Object.keys(targets)
  const multi = labels.length > 1

  const outputs = []
  const builds = labels.map(async (label) => {
    const target = targets[label]
    const targetLog = multi
      ? makeLogger(`${config.name} ${label}`, { verbose: config.verbose })
      : log
    const outDir = multi ? path.join(config.outDir, label) : config.outDir
    const args = await zigArgsFor(config, toolchain, target, outDir, targetLog)
    await run(toolchain.zig.exe, args, {
      cwd: config.root,
      env: { ...process.env, ...config.env },
      log: targetLog,
    })
    outputs.push(path.join(config.root, outDir))
  })

  // Targets are independent; building them at once is the whole reason cross
  // compilation is cheap here.
  await Promise.all(builds)

  log.step(`built ${outputs.length === 1 ? outputs[0] : `${outputs.length} targets`}`)
  return { outputs }
}

/**
 * Removes everything the build produces, leaving the downloaded toolchain in
 * place — that one is shared between projects and expensive to fetch again.
 *
 * @param {object} [overrides]
 */
export async function clean(overrides = {}) {
  const config = await resolveConfig(overrides)
  const log = makeLogger(config.name, { verbose: config.verbose })
  for (const rel of [config.outDir, config.cacheDir, config.templateDir]) {
    const dir = path.join(config.root, rel)
    if (exists(dir)) {
      await removeDir(dir)
      log(`removed ${rel}`)
    }
  }
  const cdb = path.join(config.root, 'compile_commands.json')
  if (exists(cdb)) {
    await removeDir(cdb)
    log('removed compile_commands.json')
  }
}

/**
 * Reports what a build would use, without building anything. The first thing
 * to run when a build behaves unexpectedly.
 *
 * @param {object} [overrides]
 */
export async function info(overrides = {}) {
  const config = await resolveConfig(overrides)
  const log = makeLogger('info', { verbose: true, colour: 'cyan' })
  const targets = await withHostTriple(config.targets)

  const zig = await resolveZig({
    version: config.zigVersion,
    zigExe: config.zigExe,
    useSystemZig: config.useSystemZig,
    offline: true,
    log,
  }).catch((err) => ({
    exe: `(not installed: ${err.message})`,
    version: config.zigVersion,
    source: 'missing',
  }))

  const rows = [
    ['project', config.root],
    ['artifact name', config.name],
    ['kind', config.napi ? 'Node-API addon' : 'library / executable'],
    [
      'targets',
      Object.values(targets)
        .map((t) => t.triple)
        .join(', '),
    ],
    ['optimize', config.optimize],
    ['output', path.join(config.root, config.outDir)],
    ['zig', `${zig.version} (${zig.source}) ${zig.exe}`],
    ['zig cache', cacheHome()],
    ['template', path.join(config.root, config.templateDir)],
  ]

  if (config.napi) {
    const headers = await resolveNodeHeaders({
      version: config.nodeVersion,
      mode: config.nodeHeaders,
      root: config.root,
      offline: true,
      log,
    }).catch((err) => ({ includeDir: `(not downloaded: ${err.message})`, source: 'missing' }))
    const addonApi = resolveNodeAddonApi(config.root)
    const apiHeaders = resolveNodeApiHeadersPackage(config.root)
    rows.push(['node version', config.nodeVersion])
    rows.push(['node headers', `${headers.includeDir} [${headers.source}]`])
    rows.push(['node-addon-api', describePackage(addonApi)])
    rows.push(['node-api-headers', describePackage(apiHeaders)])
    rows.push(['napi version', String(config.napiVersion)])
  }

  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [key, value] of rows) {
    log.raw(`  ${c.grey(key.padEnd(width))}  ${value}`)
  }
  return { config, targets }
}

/**
 * Runs the managed Zig binary with arbitrary arguments, so a project never
 * needs a second, separately installed Zig.
 *
 * @param {string[]} args
 * @param {object} [overrides]
 */
export async function zig(args, overrides = {}) {
  const config = await resolveConfig(overrides)
  const toolchain = await resolveZig({
    version: config.zigVersion,
    zigExe: config.zigExe,
    useSystemZig: config.useSystemZig,
    offline: config.offline,
    log: rootLog,
  })
  // `zig fetch` writes into the global cache; pointing it at the same one the
  // build uses means a package is downloaded once, not once per command.
  await run(toolchain.exe, args, {
    cwd: config.root,
    env: {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: config.globalCacheDir ?? path.join(cacheHome(), 'zig-global-cache'),
      ...config.env,
    },
    log: rootLog,
  })
}

// ---------------------------------------------------------------------------

/**
 * How a resolved header package is reported.
 *
 * Whether the headers came from the project or from this package is worth
 * saying out loud: a project that pins its own version and a project that
 * inherits ours behave differently the day the majors diverge.
 */
function describePackage(resolved) {
  if (!resolved) {
    return 'not installed'
  }
  const origin = resolved.declared ? 'declared by the project' : 'via zig-native-build'
  return `${resolved.version} (${origin}) ${resolved.includeDir}`
}

/** Downloads and locates everything the compiler needs. */
async function prepare(config, log) {
  await syncTemplate(config.root, config.templateDir, log)
  checkZonDependency(config.root, config.templateDir, log)

  const zigToolchain = await resolveZig({
    version: config.zigVersion,
    zigExe: config.zigExe,
    useSystemZig: config.useSystemZig,
    offline: config.offline,
    log,
  })

  let nodeHeaders
  let addonApi
  let apiHeadersPackage
  if (config.napi) {
    nodeHeaders = await resolveNodeHeaders({
      version: config.nodeVersion,
      mode: config.nodeHeaders,
      root: config.root,
      offline: config.offline,
      log,
    })
    addonApi = resolveNodeAddonApi(config.root)
    apiHeadersPackage = resolveNodeApiHeadersPackage(config.root)
    log.debug(`node headers: ${nodeHeaders.includeDir} [${nodeHeaders.source}]`)
    if (addonApi) {
      log.debug(`node-addon-api ${describePackage(addonApi)}`)
    }
  }

  return { zig: zigToolchain, nodeHeaders, addonApi, apiHeadersPackage }
}

/** Builds the argument list for one `zig build` invocation. */
async function zigArgsFor(config, toolchain, target, outDir, log) {
  const args = ['build', ...config.steps]

  args.push(`-Dtarget=${target.triple}`)
  if (target.cpu) {
    args.push(`-Dcpu=${target.cpu}`)
  }
  args.push(`-Doptimize=${config.optimize}`)

  if (config.napi) {
    args.push(`-Dnode-headers=${toolchain.nodeHeaders.includeDir}`)
    if (toolchain.addonApi) {
      args.push(`-Dnapi-headers=${toolchain.addonApi.includeDir}`)
    }
    args.push(`-Dnapi-version=${config.napiVersion}`)

    if (target.baseTriple.includes('windows')) {
      await addWindowsLinkArgs(args, config, toolchain, target, log)
    }
  }

  if (target.rpath) {
    args.push(`-Drpath=${target.rpath}`)
  }

  for (const [key, value] of Object.entries(config.zigOptions)) {
    args.push(value === true ? `-D${key}` : `-D${key}=${value}`)
  }

  if (config.buildFile !== 'build.zig') {
    args.push('--build-file', config.buildFile)
  }
  args.push('-p', outDir)
  args.push('--cache-dir', config.cacheDir)
  args.push(
    '--global-cache-dir',
    config.globalCacheDir ?? path.join(cacheHome(), 'zig-global-cache'),
  )
  if (config.verbose) {
    args.push('--verbose')
  }
  args.push(...config.zigArgs)

  return args
}

/**
 * Windows cannot leave the Node-API symbols undefined, so the addon links
 * against an import library.
 *
 * A `.def` file is preferred when `node-api-headers` is installed: it is a few
 * kilobytes, it needs no download, and it is the only way to produce an import
 * library for Bun, whose exports live in `bun.exe`. Otherwise `node.lib` is
 * downloaded from nodejs.org, exactly as node-gyp does.
 */
async function addWindowsLinkArgs(args, config, toolchain, target, log) {
  const def = toolchain.apiHeadersPackage?.nodeApiDef
  if (def && exists(def)) {
    args.push(`-Dnode-api-def=${def}`)
    if (await wantsBunAddon(config)) {
      args.push('-Dbun=true')
      log.debug('building a separate Bun addon (bun.exe is on PATH)')
    }
    return
  }

  const nodeLib = await resolveNodeLib({
    version: config.nodeVersion,
    triple: target.baseTriple,
    log,
  })
  args.push(`-Dnode-lib=${nodeLib}`)

  if (await wantsBunAddon(config)) {
    log.warn(
      'Bun was detected but `node-api-headers` is not installed, so no Bun addon ' +
        'can be built. Add it as a devDependency to enable it.',
    )
  }
}

async function wantsBunAddon(config) {
  if (config.bun !== 'auto') {
    return Boolean(config.bun)
  }
  const { code } = await capture('bun', ['--version'])
  return code === 0
}
