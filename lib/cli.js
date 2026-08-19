#!/usr/bin/env node
/**
 * The command line front end.
 *
 *   zig-native-build              build the project in the current directory
 *   zig-native-build init         create build.zig, build.zig.zon and the rest
 *   zig-native-build clean        remove everything the build produced
 *   zig-native-build info         report what a build would use
 *   zig-native-build zig -- ...   run the managed Zig toolchain
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tryReadJson } from './fsutil.js'
import { build, clean, info, zig } from './index.js'
import { c, rootLog } from './log.js'
import { init } from './scaffold.js'

const FLAGS = {
  '--root': 'root',
  '--name': 'name',
  '--target': 'targets',
  '--optimize': 'optimize',
  '-O': 'optimize',
  '--zig-version': 'zigVersion',
  '--zig-exe': 'zigExe',
  '--node-version': 'nodeVersion',
  '--node-headers': 'nodeHeaders',
  '--napi-version': 'napiVersion',
  '--out-dir': 'outDir',
  '--build-file': 'buildFile',
  '--template-dir': 'templateDir',
  '--cache-dir': 'cacheDir',
  '--global-cache-dir': 'globalCacheDir',
  '--language': 'language',
}

const BOOLEAN_FLAGS = {
  '--verbose': ['verbose', true],
  '-v': ['verbose', true],
  '--debug': ['optimize', 'debug'],
  '--release': ['optimize', 'fast'],
  '--system-zig': ['useSystemZig', true],
  '--offline': ['offline', true],
  '--napi': ['napi', true],
  '--no-napi': ['napi', false],
  '--bun': ['bun', true],
  '--no-bun': ['bun', false],
  '--force': ['force', true],
  '--lib': ['addon', false],
  '--no-config': ['skipConfigFile', true],
}

function parse(argv) {
  const options = {}
  const positional = []
  const passthrough = []
  const steps = []
  let afterDoubleDash = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (afterDoubleDash) {
      passthrough.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--version' || arg === '-V') {
      options.version = true
      continue
    }
    if (arg === '--step') {
      steps.push(argv[++i])
      continue
    }
    if (arg in BOOLEAN_FLAGS) {
      const [key, value] = BOOLEAN_FLAGS[arg]
      options[key] = value
      continue
    }

    // --key=value as well as --key value
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (name in FLAGS) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
      const key = FLAGS[name]
      // --target may be repeated to cross compile several triples at once.
      if (key === 'targets' && options.targets) {
        options.targets = [...toArray(options.targets), value]
      } else {
        options[key] = value
      }
      continue
    }
    if (name.startsWith('-')) {
      throw new Error(`unknown option '${arg}'. Try --help.`)
    }
    positional.push(arg)
  }

  if (steps.length > 0) {
    options.steps = steps
  }
  return { command: positional[0], positional: positional.slice(1), options, passthrough }
}

function toArray(value) {
  return Array.isArray(value) ? value : [value]
}

function usage() {
  const lines = [
    '',
    c.bold('zig-native-build') + ' - build native C/C++ Node.js modules with Zig',
    '',
    c.bold('Usage'),
    '  zig-native-build [build] [options]     build the project (the default)',
    '  zig-native-build init [options]        create the build files',
    '  zig-native-build clean                 remove build output and caches',
    '  zig-native-build info                  show what a build would use',
    '  zig-native-build zig -- <args>         run the managed Zig toolchain',
    '',
    c.bold('Common options'),
    '  --root <dir>            project directory (default: the current one)',
    '  -O, --optimize <mode>   debug | safe | fast | small (default: small)',
    '  --debug                 shorthand for -O debug',
    '  --target <triple>       cross compile; repeat for several targets',
    '  --step <name>           run an extra `zig build` step, e.g. --step test',
    '  -v, --verbose           show the commands being run',
    '',
    c.bold('Toolchain options'),
    '  --zig-version <ver>     Zig release to download (default: the bundled one)',
    '  --zig-exe <path>        use this Zig instead of downloading one',
    '  --system-zig            use `zig` from PATH when its version matches',
    '  --node-version <ver>    Node headers to compile against (default: .nvmrc)',
    '  --node-headers <mode>   auto | download | package | <path>',
    '  --offline               fail rather than download anything',
    '',
    c.bold('init options'),
    '  --name <name>           artifact name (default: from package.json)',
    '  --language <c|c++>      which example sources to write (default: c)',
    '  --lib                   a plain library rather than a Node addon',
    '  --force                 overwrite files that already exist',
    '',
    c.bold('Examples'),
    '  zig-native-build init --language c++',
    '  zig-native-build --debug --verbose',
    '  zig-native-build --target x86_64-linux-gnu --target aarch64-macos',
    '  zig-native-build zig -- fmt --check build.zig',
    '',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main() {
  const { command, options, passthrough } = parse(process.argv.slice(2))

  if (options.version) {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkg = tryReadJson(path.join(here, '..', 'package.json'))
    process.stdout.write(`${pkg?.version ?? 'unknown'}\n`)
    return
  }
  if (options.help || command === 'help') {
    usage()
    return
  }

  // `help` and `version` were handled above; `language`, `addon` and `force`
  // belong to `init` alone. Everything else is build configuration.
  const { help: _help, version: _version, language, addon, force, ...config } = options

  switch (command) {
    case undefined:
    case 'build':
      // Anything after `--` goes to the Zig build itself, which is how
      // `--step run -- <args>` reaches the program being run.
      await build(passthrough.length > 0 ? { ...config, zigArgs: ['--', ...passthrough] } : config)
      return
    case 'init':
      await init({ root: config.root, name: config.name, language, addon, force })
      return
    case 'clean':
      await clean(config)
      return
    case 'info':
      await info(config)
      return
    case 'zig':
      if (passthrough.length === 0) {
        throw new Error('nothing to pass to zig. Use: zig-native-build zig -- version')
      }
      await zig(passthrough, config)
      return
    default:
      throw new Error(`unknown command '${command}'. Try --help.`)
  }
}

main().catch((error) => {
  rootLog.error(error.message)
  if (error.cause) {
    rootLog.error(`  caused by: ${error.cause.message ?? error.cause}`)
  }
  if (process.env.ZIG_NATIVE_BUILD_DEBUG) {
    // biome-ignore lint/suspicious/noConsole: a stack trace is the whole point of this flag
    console.error(error)
  }
  process.exitCode = 1
})
