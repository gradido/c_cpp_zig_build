import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findUp } from './fsutil.js'
import { capture } from './proc.js'

/** Root of everything this tool downloads. Override with C_CPP_ZIG_BUILD_HOME. */
export function cacheHome() {
  return process.env.C_CPP_ZIG_BUILD_HOME || path.join(os.homedir(), '.zig-build')
}

export function isWindows() {
  return process.platform === 'win32'
}

export function isMacos() {
  return process.platform === 'darwin'
}

let muslCache
/**
 * True when the host's libc is musl.
 *
 * Node reports the runtime glibc version in its diagnostic report on any
 * glibc system; its absence on Linux means musl. `ldd` is only consulted when
 * the report is unavailable, which keeps this dependency-free and fast.
 *
 * @returns {Promise<boolean>}
 */
export async function isMusl() {
  if (muslCache !== undefined) {
    return muslCache
  }
  if (process.platform !== 'linux') {
    muslCache = false
    return muslCache
  }
  try {
    const report = process.report?.getReport()
    const header = typeof report === 'string' ? JSON.parse(report).header : report?.header
    if (header && typeof header.glibcVersionRuntime === 'string') {
      muslCache = false
      return muslCache
    }
    if (header) {
      // A report without a glibc version on Linux is musl.
      muslCache = true
      return muslCache
    }
  } catch {
    // fall through to the ldd probe
  }
  const { stdout, stderr } = await capture('ldd', ['--version'])
  muslCache = /musl/i.test(`${stdout}${stderr}`)
  return muslCache
}

/**
 * The Zig target triple describing the machine we are running on.
 *
 * This is only the default; `targets` in the config overrides it, and any
 * triple Zig understands can be named there for cross compilation.
 *
 * @returns {Promise<string>}
 */
export async function detectHostTriple() {
  const { platform, arch } = process

  if (platform === 'win32') {
    if (arch === 'x64') {
      return 'x86_64-windows'
    }
    if (arch === 'arm64') {
      return 'aarch64-windows'
    }
    if (arch === 'ia32') {
      return 'x86-windows'
    }
  }

  if (platform === 'darwin') {
    if (arch === 'x64') {
      return 'x86_64-macos'
    }
    if (arch === 'arm64') {
      return 'aarch64-macos'
    }
  }

  if (platform === 'linux') {
    const musl = await isMusl()
    if (arch === 'x64') {
      return musl ? 'x86_64-linux-musl' : 'x86_64-linux-gnu'
    }
    if (arch === 'arm64') {
      return musl ? 'aarch64-linux-musl' : 'aarch64-linux-gnu'
    }
    if (arch === 'ia32') {
      return musl ? 'x86-linux-musl' : 'x86-linux-gnu'
    }
    if (arch === 'ppc64') {
      return musl ? 'powerpc64le-linux-musl' : 'powerpc64le-linux-gnu'
    }
    if (arch === 'riscv64') {
      return musl ? 'riscv64-linux-musl' : 'riscv64-linux-gnu'
    }
    if (arch === 'arm') {
      // Node cannot tell hard-float from soft-float apart; hard-float is what
      // every distribution ships today.
      return musl ? 'arm-linux-musleabihf' : 'arm-linux-gnueabihf'
    }
  }

  if (platform === 'freebsd' && arch === 'x64') {
    return 'x86_64-freebsd'
  }

  throw new Error(
    `unsupported platform/arch combination: ${platform}/${arch}. ` +
      'Set `targets` explicitly in your config if Zig supports this triple.',
  )
}

/** The key under which ziglang.org's index.json lists a build for this host. */
export function zigHostKey() {
  const archMap = {
    x64: 'x86_64',
    arm64: 'aarch64',
    ia32: 'x86',
    arm: 'arm',
    riscv64: 'riscv64',
    ppc64: 'powerpc64le',
  }
  const osMap = {
    win32: 'windows',
    darwin: 'macos',
    linux: 'linux',
    freebsd: 'freebsd',
    netbsd: 'netbsd',
  }
  const arch = archMap[process.arch]
  const osName = osMap[process.platform]
  if (!arch || !osName) {
    throw new Error(`no Zig build is published for ${process.platform}/${process.arch}`)
  }
  return `${arch}-${osName}`
}

/**
 * The Node version whose headers should be compiled against.
 *
 * The nearest `.nvmrc` wins over the running interpreter, so that a repository
 * that pins its Node version builds addons for that version even when the
 * developer's shell happens to have another one active. N-API is ABI stable,
 * so this mostly decides which `v8.h` and `uv.h` are available.
 *
 * @param {string} from directory to search upwards from
 * @returns {string} a bare version such as `18.20.7`
 */
export function detectNodeVersion(from) {
  const nvmrc = findUp(from, '.nvmrc')
  if (nvmrc) {
    const raw = fs.readFileSync(nvmrc, 'utf8').trim().replace(/^v/, '')
    // `.nvmrc` may hold an alias (`lts/*`, `node`); only a concrete version is
    // usable as a download path.
    if (/^\d+\.\d+\.\d+$/.test(raw)) {
      return raw
    }
  }
  return process.versions.node
}

/** The architecture folder used by nodejs.org for Windows import libraries. */
export function nodeWindowsArch(triple) {
  if (triple.includes('windows')) {
    if (triple.startsWith('x86_64')) {
      return 'win-x64'
    }
    if (triple.startsWith('aarch64')) {
      return 'win-arm64'
    }
    if (triple.startsWith('x86-')) {
      return 'win-x86'
    }
  }
  throw new Error(`no Windows node.lib is published for target ${triple}`)
}

export function cpuCount() {
  try {
    return os.availableParallelism?.() ?? os.cpus().length ?? 1
  } catch {
    return 1
  }
}
