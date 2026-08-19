/**
 * zig-native-build — build native C/C++ Node.js modules with Zig.
 *
 * Most projects never import this: `zig-native-build` on the command line is
 * the whole interface. The API is here for build scripts that need to compute
 * something before building, or to drive several projects at once.
 */

/** A Zig optimisation mode, or the short alias for it. */
export type OptimizeMode =
  | 'Debug'
  | 'ReleaseSafe'
  | 'ReleaseFast'
  | 'ReleaseSmall'
  | 'debug'
  | 'safe'
  | 'fast'
  | 'small'

/** How the Node headers are obtained. */
export type NodeHeadersMode =
  /** Download from nodejs.org; fall back to `node-api-headers` when offline. */
  | 'auto'
  /** Always download from nodejs.org. */
  | 'download'
  /** Use the installed `node-api-headers` package. */
  | 'package'
  /** A directory containing `node_api.h`. */
  | (string & {})

/** One cross-compilation target. */
export interface TargetConfig {
  /** A Zig target triple, e.g. `x86_64-linux-gnu` or `aarch64-macos`. */
  triple?: string
  /** Target CPU or feature set. Defaults to `baseline`. */
  cpu?: string
  /** Minimum glibc version to link against, e.g. `2.28`. GNU targets only. */
  glibc?: string
  /** Runtime library search path baked into the artifact. */
  rpath?: string
}

export interface Config {
  /** Project directory. Defaults to the current working directory. */
  root?: string
  /**
   * Label used in log output. The artifact's real name lives in `build.zig`;
   * this only affects what you read in the terminal.
   */
  name?: string

  /**
   * Build a Node-API addon: pass the Node headers to the compiler and, on
   * Windows, link an import library. `'auto'` decides from the layout — a
   * `napi/` or `bindings/` directory, or a `.node` entry point.
   */
  napi?: boolean | 'auto'
  /** Node-API version to target. Defaults to 8. */
  napiVersion?: number
  /** Node version whose headers to use. Defaults to the nearest `.nvmrc`. */
  nodeVersion?: string
  /** Where the Node headers come from. Defaults to `'auto'`. */
  nodeHeaders?: NodeHeadersMode
  /**
   * Build the extra Bun addon on Windows, where Bun exports the Node-API from
   * `bun.exe`. `'auto'` builds it whenever Bun is installed.
   */
  bun?: boolean | 'auto'

  /**
   * What to build for. One triple, several, or a named map. Several targets
   * build in parallel, each into its own subdirectory of `outDir`.
   */
  targets?: string | string[] | Record<string, string | TargetConfig>
  /** Target CPU for every target that does not name its own. */
  cpu?: string

  /** Optimisation mode. Defaults to `ReleaseSmall`. */
  optimize?: OptimizeMode
  /** Build script to run. Defaults to `build.zig`. */
  buildFile?: string
  /** Install prefix, relative to the project. Defaults to `build`. */
  outDir?: string
  /** Extra `zig build` steps to run, e.g. `['test']`. */
  steps?: string | string[]
  /** Extra `-D` options passed to `build.zig`. */
  zigOptions?: Record<string, string | number | boolean>
  /** Raw arguments appended to the `zig build` command line. */
  zigArgs?: string | string[]

  /** Zig release to download. Defaults to the one this package ships with. */
  zigVersion?: string
  /** Use this Zig binary instead of downloading one. */
  zigExe?: string
  /** Use `zig` from PATH when its version matches `zigVersion`. */
  useSystemZig?: boolean
  /** Fail rather than download anything. */
  offline?: boolean

  /** Where the Zig template is copied to. Defaults to `.zig-native`. */
  templateDir?: string
  /** Zig's per-project cache. Defaults to `.zig-cache`. */
  cacheDir?: string
  /** Zig's shared cache. Defaults to `~/.zig-build/zig-global-cache`. */
  globalCacheDir?: string

  /** Print the commands being run. */
  verbose?: boolean
  /** Extra environment variables for the compiler. */
  env?: Record<string, string>
  /** Ignore `zig-native.config.*` and the package.json `zigNative` field. */
  skipConfigFile?: boolean
}

/** The fully resolved configuration, with every default filled in. */
export interface ResolvedConfig
  extends Required<
    Omit<Config, 'targets' | 'cpu' | 'steps' | 'zigArgs' | 'skipConfigFile' | 'name'>
  > {
  name: string
  packageName?: string
  targets: Record<string, TargetConfig>
  steps: string[]
  zigArgs: string[]
}

/**
 * Builds the project, downloading the Zig toolchain and the Node headers if
 * they are not cached yet.
 */
export function build(config?: Config): Promise<{ outputs: string[] }>

/** Removes the build output, the Zig cache and the copied template. */
export function clean(config?: Config): Promise<void>

/** Prints what a build would use. Downloads nothing. */
export function info(
  config?: Config,
): Promise<{ config: ResolvedConfig; targets: Record<string, TargetConfig> }>

/** Runs the managed Zig toolchain with arbitrary arguments. */
export function zig(args: string[], config?: Config): Promise<void>

/** Identity function that gives a config file editor support. */
export function defineConfig<T extends Config>(config: T): T

/** Resolves a config the way the CLI does, without building. */
export function resolveConfig(config?: Config): Promise<ResolvedConfig>

/** Loads `zig-native.config.*` or the package.json `zigNative` field. */
export function loadConfigFile(root: string): Promise<Config>

/** Locates or downloads a Zig toolchain. */
export function resolveZig(options?: {
  version?: string
  zigExe?: string
  useSystemZig?: boolean
  offline?: boolean
}): Promise<{ exe: string; version: string; source: 'explicit' | 'system' | 'download' }>

/** The Zig release this package is written against. */
export const DEFAULT_ZIG_VERSION: string

/** Absolute path of the Zig template shipped inside this package. */
export function packagedTemplateDir(): string
