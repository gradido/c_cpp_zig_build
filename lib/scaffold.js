import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { exists, isDirectory, toIdentifier, tryReadJson } from './fsutil.js'
import { c, makeLogger } from './log.js'
import { ZIG_PACKAGE_NAME } from './template.js'

/**
 * Creates the files a project needs to build with this tool, without touching
 * anything that already exists.
 *
 * @param {{
 *   root?: string,
 *   name?: string,
 *   language?: 'c' | 'c++',
 *   addon?: boolean,
 *   force?: boolean,
 * }} [options]
 */
export async function init(options = {}) {
  const root = path.resolve(options.root ?? process.cwd())
  const log = makeLogger('init', { colour: 'green' })
  const pkg = tryReadJson(path.join(root, 'package.json'))
  const name = options.name ?? toIdentifier(pkg?.name ?? path.basename(root))
  const language = options.language ?? 'c'
  const addon = options.addon ?? true
  const ext = language === 'c++' ? 'cpp' : 'c'

  const created = []
  const skipped = []

  const write = (relative, contents) => {
    const file = path.join(root, relative)
    if (exists(file) && !options.force) {
      skipped.push(relative)
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
    created.push(relative)
  }

  write('build.zig', buildZig(name, addon))
  write('build.zig.zon', buildZigZon(name))

  if (!isDirectory(path.join(root, 'src'))) {
    write(`src/${name}.${ext}`, exampleSource(name, language))
    write(`include/${name}.h`, exampleHeader(name, language))
  }
  if (addon && !isDirectory(path.join(root, 'napi'))) {
    write(`napi/binding.${ext}`, language === 'c++' ? bindingCpp(name) : bindingC(name))
  }
  if (addon) {
    write('index.cjs', indexCjs(name))
  }

  updateGitignore(root, log)
  updatePackageJson(root, log)

  for (const file of created) {
    log(`${c.green('created')} ${file}`)
  }
  for (const file of skipped) {
    log(`${c.grey('kept')}    ${file}`)
  }

  log.raw('')
  log.step('next: install the build tool and run it')
  log.raw(`  ${c.grey('npm i -D c-cpp-zig-build')}   ${c.grey('# or: bun add -d / yarn add -D')}`)
  log.raw(`  ${c.grey('npm run build')}`)
  log.raw('')

  return { created, skipped }
}

/**
 * A Zig package fingerprint: the CRC-32 of the package name in the high half,
 * a random id in the low half. Zig rejects any other value, and reporting the
 * right one is the only thing it does with a wrong one — so it is computed
 * here rather than left for the first failed build to explain.
 *
 * @param {string} name
 */
export function fingerprint(name) {
  let crc = 0xffffffff
  for (const byte of Buffer.from(name, 'utf8')) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  const checksum = (crc ^ 0xffffffff) >>> 0
  // 0 and 0xffffffff are reserved as "unset".
  const id = randomInt(1, 0xffffffff)
  return `0x${checksum.toString(16).padStart(8, '0')}${id.toString(16).padStart(8, '0')}`
}

function buildZig(name, addon) {
  if (!addon) {
    return `const std = @import("std");
const czb = @import("${ZIG_PACKAGE_NAME}");

pub fn build(b: *std.Build) !void {
    _ = try czb.addStaticLibrary(b, .{ .name = "${name}" });
}
`
  }
  return `const std = @import("std");
const czb = @import("${ZIG_PACKAGE_NAME}");

pub fn build(b: *std.Build) !void {
    // Compiles everything under src/ and napi/, puts include/ and third_party/
    // on the header search path, and installs ${name}.node into the
    // output directory. See the c-cpp-zig-build README for the options.
    _ = try czb.addNodeAddon(b, .{ .name = "${name}" });
}
`
}

function buildZigZon(name) {
  return `.{
    .name = .${name},
    .version = "0.1.0",
    .fingerprint = ${fingerprint(name)},
    .minimum_zig_version = "0.15.1",
    .dependencies = .{
        // The build template, kept in sync by \`c-cpp-zig-build\`.
        // Add your own dependencies here with \`zig fetch --save <url>\`.
        .${ZIG_PACKAGE_NAME} = .{ .path = ".zig-native" },
    },
    .paths = .{ "build.zig", "build.zig.zon", "src", "napi", "include", "third_party" },
}
`
}

function exampleHeader(name, language) {
  const guard = `${name.toUpperCase()}_H`
  const open = language === 'c++' ? '\n#ifdef __cplusplus\nextern "C" {\n#endif\n' : ''
  const close = language === 'c++' ? '\n#ifdef __cplusplus\n}\n#endif\n' : ''
  return `#ifndef ${guard}
#define ${guard}

#include <stdint.h>
${open}
/** Adds two integers. Replace with the real thing. */
int64_t ${name}_add(int64_t a, int64_t b);
${close}
#endif /* ${guard} */
`
}

function exampleSource(name) {
  return `#include "${name}.h"

int64_t ${name}_add(int64_t a, int64_t b) {
  return a + b;
}
`
}

function bindingC(name) {
  return `/*
 * The Node-API layer. Keep it thin: it should convert values and call into
 * src/, so the same code can also be linked into a test binary or a CLI.
 */

#include <node_api.h>

#include "${name}.h"

static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "add(a, b) expects two numbers");
    return NULL;
  }

  int64_t a = 0;
  int64_t b = 0;
  napi_get_value_int64(env, argv[0], &a);
  napi_get_value_int64(env, argv[1], &b);

  napi_value result;
  napi_create_int64(env, ${name}_add(a, b), &result);
  return result;
}

NAPI_MODULE_INIT(/* env, exports */) {
  napi_property_descriptor properties[] = {
      {"add", NULL, Add, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 1, properties) != napi_ok) {
    napi_throw_error(env, NULL, "failed to define module properties");
    return NULL;
  }
  return exports;
}
`
}

function bindingCpp(name) {
  return `// The Node-API layer, using node-addon-api. Its headers ship with
// c-cpp-zig-build, so this compiles as it stands. Declare it in package.json
// if you want to pin the version you build against:
//   npm i -D node-addon-api

#include <napi.h>

#include "${name}.h"

namespace {

Napi::Value Add(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    throw Napi::TypeError::New(env, "add(a, b) expects two numbers");
  }
  const int64_t sum = ${name}_add(info[0].As<Napi::Number>().Int64Value(),
                                  info[1].As<Napi::Number>().Int64Value());
  return Napi::Number::New(env, static_cast<double>(sum));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("add", Napi::Function::New(env, Add));
  return exports;
}

}  // namespace

NODE_API_MODULE(${name}, Init)
`
}

function indexCjs(name) {
  return `/**
 * The entry point. Loading the addon by a path relative to this file keeps the
 * caller's working directory out of it.
 */

const os = require('node:os')

const isBun = typeof process !== 'undefined' && 'bun' in process.versions
const isWindows = os.platform() === 'win32'

let nativeBinding
try {
  // On Windows, Bun resolves the Node-API from bun.exe, so it gets its own
  // addon. Everywhere else one file serves both runtimes.
  nativeBinding =
    isBun && isWindows
      ? require('./build/${name}.bun.node')
      : require('./build/${name}.node')
} catch (cause) {
  throw new Error('the native addon is not built - run \`npm run build\`', { cause })
}

module.exports = nativeBinding
`
}

const GITIGNORE_ENTRIES = [
  '# c-cpp-zig-build',
  '.zig-native/',
  '.zig-cache/',
  'build/',
  'compile_commands.json',
]

function updateGitignore(root, log) {
  const file = path.join(root, '.gitignore')
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : ''
  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => entry.startsWith('#') || !current.split('\n').some((line) => line.trim() === entry),
  )
  // Only the comment left means every real entry is already there.
  if (missing.length <= 1) {
    return
  }
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(file, `${current}${separator}\n${missing.join('\n')}\n`)
  log(`${c.green('updated')} .gitignore`)
}

function updatePackageJson(root, log) {
  const file = path.join(root, 'package.json')
  const pkg = tryReadJson(file)
  if (!pkg) {
    log.warn('no package.json here; add the scripts yourself once you create one')
    return
  }
  pkg.scripts ??= {}
  let changed = false
  for (const [key, value] of Object.entries({
    build: 'c-cpp-zig-build',
    'build:debug': 'c-cpp-zig-build --debug',
    'build:clean': 'c-cpp-zig-build clean',
  })) {
    if (!pkg.scripts[key]) {
      pkg.scripts[key] = value
      changed = true
    }
  }
  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
    log(`${c.green('updated')} package.json scripts`)
  }
}
