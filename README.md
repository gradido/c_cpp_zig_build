# zig-native-build

Build native C/C++ Node.js modules with Zig, without a system toolchain.

`npm run build` downloads the Zig compiler and the Node headers, compiles your
C and C++ sources, and writes a `.node` addon. There is no `node-gyp`, no
Python, no Visual Studio, no `build-essential` — and cross compiling to another
platform is one flag.

```bash
npm i -D zig-native-build
npx zig-native-build init
npm run build
```

---

## Contents

- [Why](#why)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [The `build.zig` API](#the-buildzig-api)
- [Adding dependencies](#adding-dependencies)
- [Configuration](#configuration)
- [Cross compilation](#cross-compilation)
- [Windows and Bun](#windows-and-bun)
- [Editor support](#editor-support)
- [Package managers and monorepos](#package-managers-and-monorepos)
- [Continuous integration](#continuous-integration)
- [Examples](#examples)
- [Porting an existing Zig build](#porting-an-existing-zig-build)
- [Coming from node-gyp](#coming-from-node-gyp)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)

---

## Why

A native module normally needs a C toolchain on every machine that builds it,
and a different one per platform. Zig ships a C and C++ compiler, libc for
every target it supports, and a build system, in a single 50 MB download — so
the toolchain can be a dependency of the project rather than a prerequisite of
the machine.

This package makes that practical:

- **Nothing to install.** The Zig toolchain and the Node headers are downloaded
  on first build and cached in `~/.zig-build`, shared across all your projects.
  `node-addon-api` and `node-api-headers` come along as dependencies, so C++
  bindings and Windows builds work without a project adding anything.
- **Verified downloads.** Every archive is checked against the SHA-256 published
  by ziglang.org and nodejs.org before it is unpacked.
- **A build file you can read.** `build.zig` is usually four lines. The template
  behind it is a normal Zig package, and the artifact it returns is a normal
  `std.Build.Step.Compile`, so nothing is out of reach.
- **Cross compilation as a flag.** `--target aarch64-macos` from a Linux box
  produces a macOS addon. So does `--target x86_64-windows`.
- **Both runtimes.** Node and Bun, including the separate addon Bun needs on
  Windows.
- **No lock-in for the C code.** The same sources build as a static library and
  as a command line tool, so the logic stays testable without a JS runtime.

Node-API is deliberately *not* part of this package. The bindings are yours to
write, in C or in C++ with `node-addon-api`; this only builds them.

---

## Requirements

| | |
|---|---|
| Node.js | 18.17 or newer (Bun and Yarn work too — they run the same CLI) |
| Disk | ~150 MB in `~/.zig-build` for the toolchain and headers |
| Network | On the first build only, then never again |
| `tar` | Present on macOS, Linux, and Windows 10 1803+ |

No compiler, no Python, no Visual Studio Build Tools.

This package depends on `node-addon-api` and `node-api-headers` and nothing
else. Both are header-only, carry no dependencies of their own, and together
add about 300 kB — they are what makes C++ bindings and Windows builds work
with no setup.

---

## Quick start

### A new module

```bash
mkdir my-native && cd my-native
npm init -y
npm i -D zig-native-build
npx zig-native-build init
npm run build
```

`init` writes `build.zig`, `build.zig.zon`, a small example library in `src/`
and `include/`, a Node-API binding in `napi/`, an `index.cjs` that loads the
result, and the `build` scripts in `package.json`. It never overwrites a file
that already exists.

```js
const native = require('./index.cjs')
native.add(20, 22) // 42
```

### An existing module

If you already have C sources, run `init` and then delete the example files it
wrote. Point `build.zig` at your layout if it differs from the default:

```zig
const std = @import("std");
const znb = @import("zig_native_build");

pub fn build(b: *std.Build) !void {
    _ = try znb.addNodeAddon(b, .{
        .name = "my_native",
        .sources = &.{ .{ .dir = "lib" }, .{ .dir = "bindings/node" } },
        .include = &.{ "lib/include", "vendor" },
    });
}
```

### For C++

```bash
npx zig-native-build init --language c++
```

`node-addon-api` ships as a dependency of this package, so `#include <napi.h>`
works straight away, and libc++ is linked automatically when any C++ source is
present.

Declare it in your own project anyway if you care which version you compile
against — a version the project declares always wins over the bundled one:

```bash
npm i -D node-addon-api
```

`zig-native-build info` prints which copy is in use.

---

## How it works

```
npm run build
  └─ zig-native-build
       ├─ copies the Zig template into .zig-native/          (every build, fast)
       ├─ downloads Zig            → ~/.zig-build/zig/0.15.2/
       ├─ downloads Node headers   → ~/.zig-build/node/v22.11.0/
       ├─ finds node-addon-api (yours if you declare one, otherwise its own)
       └─ runs: zig build -Dtarget=… -Doptimize=… -Dnode-headers=… -p build
            └─ your build.zig
                 └─ the template: walks src/ and napi/, compiles, links,
                    installs build/my_native.node, writes compile_commands.json
```

**Where things go**

| Path | What | Commit it? |
|---|---|---|
| `~/.zig-build/zig/<version>/` | the Zig toolchain | shared, outside the project |
| `~/.zig-build/node/v<version>/` | Node headers and `node.lib` | shared, outside the project |
| `~/.zig-build/zig-global-cache/` | fetched Zig packages | shared, outside the project |
| `.zig-native/` | the build template, copied in | no |
| `.zig-cache/` | Zig's build cache | no |
| `build/` | the addon and any other artifacts | no |
| `compile_commands.json` | for clangd | no |
| `build.zig`, `build.zig.zon` | yours | **yes** |

`init` adds the first four to `.gitignore`.

**Why the template is copied into the project.** A `build.zig.zon` dependency
needs a path, and where `node_modules` puts a package depends on the package
manager: npm hoists, pnpm symlinks into a store, Bun has its own layout, and a
workspace changes all three. A copy inside the project is the same path
everywhere. It is refreshed on every build, so upgrading the npm package
upgrades the template — do not edit it.

---

## Project layout

The defaults follow this shape. None of it is mandatory; all of it is one
option away from being something else.

```
my-native/
├── build.zig             # what to build   ← you write this (4 lines)
├── build.zig.zon         # Zig dependencies
├── package.json
├── index.cjs             # loads build/my_native.node
├── include/              # public headers            → on the include path
├── src/                  # the library itself        → compiled
├── napi/                 # the Node-API bindings     → compiled
├── third_party/          # vendored libraries        → on the include path
├── build/                # output      (generated)
└── .zig-native/          # the template (generated)
```

**Everything under `src/` and `napi/` is compiled**, recursively, by extension
(`.c`, `.cpp`, `.cc`, `.cxx`, `.m`, `.mm`, `.S`). Add a file, build, done — no
list to maintain. The file list is sorted, so the build cache key does not
depend on the order your filesystem happens to return entries in.

**`include/` and `third_party/` are on the header search path** if they exist.
A directory that does not exist is skipped rather than being an error, so
`third_party/` can appear the day you first vendor something.

**Keep the bindings thin.** `napi/` should convert values and call into `src/`.
That split is what lets the same code build as a static library and a CLI (see
[example 3](examples/03-library-cli-and-addon)) and be tested without a
JavaScript runtime in the way.

---

## The `build.zig` API

```zig
const std = @import("std");
const znb = @import("zig_native_build");

pub fn build(b: *std.Build) !void {
    _ = try znb.addNodeAddon(b, .{ .name = "my_native" });
}
```

### Entry points

| Function | Produces |
|---|---|
| `addNodeAddon(b, options)` | a shared library installed as `<name>.node` |
| `addStaticLibrary(b, options)` | `lib<name>.a` |
| `addSharedLibrary(b, options)` | `.so` / `.dylib` / `.dll` |
| `addExecutable(b, options)` | a program |

All four take the same `Options` and return the same `Artifact`. Call as many
as you like in one build script.

### Options

Only `name` is required.

```zig
_ = try znb.addNodeAddon(b, .{
    .name = "my_native",

    // --- what to compile -------------------------------------------------
    .sources = &.{ .{ .dir = "src" }, .{ .dir = "napi", .optional = true } },
    .include = &.{ "include", "third_party" },

    // --- how to compile it -----------------------------------------------
    .flags = &.{"-DMY_FEATURE=1"},   // every translation unit
    .c_flags = &.{},                  // C only
    .cpp_flags = &.{},                // C++ only
    .c_std = "c17",                   // -std=c17
    .cpp_std = "c++20",               // -std=c++20
    .warnings = true,                 // -Wall -Wextra            (default)
    .pedantic = false,                // -Wpedantic               (see below)
    .warnings_as_errors = false,      // -Werror
    .defines = &.{ .{ .name = "VERSION", .value = "\"1.2.3\"" } },
    .exceptions = true,               // false also sets the node-addon-api
                                      // no-exception macros
    .link_libc = true,
    .link_libcpp = null,              // null = when C++ sources are found

    // --- output ----------------------------------------------------------
    .out_name = null,                 // default: "<name>.node"
    .flat = false,                    // libraries: skip the bin/ and lib/ dirs
    .compile_commands = true,

    // --- overrides -------------------------------------------------------
    .target = null,                   // default: what --target selected
    .optimize = null,                 // default: what --optimize selected
    .bun = null,                      // Windows: null = when Bun is installed
});
```

### `SourceSet`

A source set is a group of files that share compiler flags.

```zig
.{
    .dir = "third_party/CRoaring",   // walked recursively when .files is empty
    .files = &.{"roaring.c"},        // or listed explicitly, relative to .dir
    .extensions = &.{".c"},          // which extensions the walk picks up
    .exclude = &.{ "tests/", "_win32" }, // substring match on the relative path
    .flags = &.{"-DCROARING_COMPILER_SUPPORTS_AVX512=0"}, // added to the artifact's
    .warnings = false,               // no -W flags for this set (see below)
    .optional = false,               // true: a missing directory is not an error
}
```

A set's `flags` are **added to** the artifact's flags, not used instead of
them — the usual reason to set them is one extra `-D` for a vendored file.

### Warnings, and vendored code

`-Wall -Wextra` are on by default. `-Wpedantic` is **not**, deliberately:
clang promotes several pedantic findings to hard errors, and real third-party
C does not survive it — CRoaring's SIMD headers, for one, fail outright. Turn
it on for your own code if you want it:

```zig
_ = try znb.addNodeAddon(b, .{ .name = "my_native", .pedantic = true });
```

Either way, silence the warnings for code you did not write, per source set:

```zig
addon.addSources(.{ .dir = "third_party/CRoaring", .files = &.{"roaring.c"}, .warnings = false });
```

### `Artifact`

What the four entry points return.

```zig
const addon = try znb.addNodeAddon(b, .{ .name = "my_native" });

addon.linkDependency("zstd", "zstd");                   // a build.zig.zon package
addon.linkDependencyWith("libsodium", "sodium", .{      // ...one that takes options
    .static = true,
    .shared = false,
});
addon.dependency("zstd", .{}); // the raw *std.Build.Dependency, for anything else
addon.addDependencyIncludePath("stb", "include");       // its headers only
addon.addIncludePath("third_party/CRoaring/include");   // a path in this project
addon.addDefine("MY_FLAG", "1");
addon.addSources(.{ .dir = "third_party/yyjson/src", .files = &.{"yyjson.c"} });
addon.linkSystemLibrary("pthread");

addon.compile        // the underlying *std.Build.Step.Compile — do anything
addon.target         // the resolved target
addon.optimize       // the optimisation mode
```

`addon.compile` is an ordinary Zig compile step. Nothing the template does not
cover is out of reach:

```zig
addon.compile.addWin32ResourceFile(.{ .file = b.path("res/version.rc") });
addon.compile.root_module.addCMacro("NDEBUG", "1");
```

### Extra steps

Anything you add to `build.zig` is reachable with `--step`:

```zig
const run = b.addRunArtifact(cli.compile);
if (b.args) |args| run.addArgs(args);
b.step("run", "Run the tool").dependOn(&run.step);
```

```bash
zig-native-build --step run -- input.txt
```

---

## Adding dependencies

Three ways, in the order you should reach for them.

### 1. A Zig package — for anything that has one

This is the "add extensions via zig" route: no vendoring, versioned, and the
dependency is cross compiled along with your code.

```bash
# `zig` here is the toolchain this package manages, so there is nothing to install
npx zig-native-build zig -- fetch --save \
  https://github.com/allyourcodebase/zstd/archive/refs/tags/1.5.7-2.tar.gz
```

That writes the URL and its hash into `build.zig.zon`. Then link it:

```zig
const addon = try znb.addNodeAddon(b, .{ .name = "my_native" });
addon.linkDependency("zstd", "zstd");   // dependency name, artifact name
```

`linkDependency` resolves the package with the artifact's own target and
optimisation mode, so `--target aarch64-macos` cross compiles zstd too. The
package's installed headers come with it — no include path to add.

A working example is in [`examples/04-zig-package-dependency`](examples/04-zig-package-dependency).
Many C libraries have a Zig package under
[github.com/allyourcodebase](https://github.com/allyourcodebase).

### 2. A file drop — for single-file and vendored libraries

Unpack it under `third_party/` and it is on the include path immediately.
Compiling it is one line:

```zig
const addon = try znb.addNodeAddon(b, .{ .name = "my_native" });

// Header-only: nothing to do beyond the default include path.

// One source file, with a flag of its own:
addon.addSources(.{
    .dir = "third_party/CRoaring",
    .files = &.{"roaring.c"},
    .flags = &.{"-DCROARING_COMPILER_SUPPORTS_AVX512=0"},
});
addon.addIncludePath("third_party/CRoaring/include");

// A whole library, skipping its tests:
addon.addSources(.{
    .dir = "third_party/yyjson",
    .exclude = &.{ "test/", "fuzz" },
});
```

To compile *everything* under `third_party/` with no special flags, just add it
to `sources`:

```zig
.sources = &.{ .{ .dir = "src" }, .{ .dir = "napi" }, .{ .dir = "third_party" } },
```

### 3. A git submodule — for a library you track upstream

```bash
git submodule add https://github.com/RoaringBitmap/CRoaring third_party/CRoaring
```

From the build's point of view a submodule is a file drop; use the same
`addSources` calls as above. Remember `git submodule update --init --recursive`
in your CI checkout.

---

## Configuration

Most projects need none. When they do, in order of precedence:

1. command line flags
2. `zig-native.config.js` / `.mjs` / `.cjs` / `.json`
3. the `zigNative` field in `package.json`
4. defaults

```js
// zig-native.config.mjs
import { defineConfig } from 'zig-native-build'

export default defineConfig({
  optimize: 'small',
  napiVersion: 8,
  targets: ['x86_64-linux-gnu', 'aarch64-linux-gnu'],
  zigOptions: { 'my-feature': true },   // -Dmy-feature, read by build.zig
})
```

```jsonc
// package.json
{
  "zigNative": { "optimize": "fast", "nodeVersion": "22.11.0" }
}
```

### Command line

```
zig-native-build [build]              build (the default command)
zig-native-build init                 create the build files
zig-native-build clean                remove build/, .zig-cache/, .zig-native/
zig-native-build info                 report what a build would use
zig-native-build zig -- <args>        run the managed Zig toolchain
```

| Flag | Meaning |
|---|---|
| `--root <dir>` | project directory |
| `-O, --optimize <mode>` | `debug`, `safe`, `fast`, `small` (default `small`) |
| `--debug` | shorthand for `-O debug` |
| `--target <triple>` | cross compile; repeat for several |
| `--step <name>` | run an extra `zig build` step |
| `-v, --verbose` | print the commands being run |
| `--zig-version <ver>` | which Zig release to download |
| `--zig-exe <path>` | use this Zig instead of downloading one |
| `--system-zig` | use `zig` from `PATH` when its version matches |
| `--node-version <ver>` | Node headers to compile against |
| `--node-headers <mode>` | `auto`, `download`, `package`, or a path |
| `--offline` | fail rather than download anything |
| `--no-napi` | build a plain library, not an addon |

Anything after `--` is passed to `zig build`, which is how
`--step run -- input.txt` reaches the program being run.

### Environment

| Variable | Effect |
|---|---|
| `ZIG_NATIVE_BUILD_HOME` | where downloads are cached (default `~/.zig-build`) |
| `ZIG_EXE` | use this Zig binary |
| `ZIG_MIRROR` | try this Zig mirror first |
| `NODEJS_ORG_MIRROR` | where to fetch Node headers from |
| `NO_COLOR` | plain output |
| `ZIG_NATIVE_BUILD_DEBUG` | print stack traces on failure |

### The Node version

Headers are chosen from, in order: `--node-version`, `nodeVersion` in the
config, the nearest `.nvmrc` walking up from the project, then the Node that is
running the build. Node-API is ABI stable, so an addon built against one
version loads in every later one — the version mostly decides which `v8.h` and
`uv.h` you can reach for.

---

## Cross compilation

```bash
zig-native-build --target x86_64-linux-gnu \
                 --target aarch64-linux-gnu \
                 --target aarch64-macos \
                 --target x86_64-windows
```

With one target the output is `build/`. With several, each gets its own
subdirectory:

```
build/
├── x86_64-linux-gnu/my_native.node
├── aarch64-linux-gnu/my_native.node
├── aarch64-macos/my_native.node
└── x86_64-windows/my_native.node
```

Targets build in parallel. Cross compiling to Windows downloads that
architecture's `node.lib` automatically.

**glibc version.** To build for an older Linux than the one you are on, name
the glibc you want:

```js
export default defineConfig({
  targets: { linux: { triple: 'x86_64-linux-gnu', glibc: '2.28' } },
})
```

Zig ships the headers and stubs for every glibc it supports, so this needs no
container.

**Loading the right one at runtime.** Pick by platform in your entry point:

```js
const { platform, arch } = process
module.exports = require(`./build/${arch}-${platform}/my_native.node`)
```

---

## Windows and Bun

A DLL may not have undefined symbols, so a Windows addon must link an import
library for the Node-API. There are two routes and the right one is chosen for
you:

- **A `.def` file**, turned into an import library by `zig dlltool`. This is
  the default: `node-api-headers` is a dependency of this package, the file is
  a few kilobytes, nothing is downloaded, and it is the only route that works
  for **Bun**, whose Node-API exports live in `bun.exe` rather than `node.exe`.
- **`node.lib`**, downloaded from nodejs.org — what node-gyp does. The fallback
  for when `node-api-headers` cannot be resolved at all. Node only.

So Bun on Windows needs nothing extra. The build produces both
`my_native.node` and `my_native.bun.node` whenever Bun is installed, and the
entry point picks:

```js
const os = require('node:os')
const isBun = 'bun' in process.versions
const isWindows = os.platform() === 'win32'

module.exports =
  isBun && isWindows
    ? require('./build/my_native.bun.node')
    : require('./build/my_native.node')
```

On Linux and macOS one file serves both runtimes — the loader resolves the
symbols either way.

---

## Editor support

Every build writes `compile_commands.json` in the project root, with the real
include paths, macros and target. clangd, ccls, VS Code's C/C++ extension and
CLion all read it, so go-to-definition works on your C sources including the
Node headers.

```bash
zig-native-build --step cdb    # write it without building anything else
```

It is rewritten only when its content changes, so your editor does not
re-index the project on every build.

---

## Package managers and monorepos

The CLI is the same everywhere; only the wrapper differs.

```jsonc
{
  "scripts": {
    "build": "zig-native-build",
    "build:debug": "zig-native-build --debug",
    "clean": "zig-native-build clean"
  }
}
```

| | |
|---|---|
| npm | `npm run build` |
| Yarn | `yarn build` |
| pnpm | `pnpm build` |
| Bun | `bun run build` |

In a monorepo, put the package in the workspace that holds the native module.
Turborepo and Nx work unchanged; a task that depends on the addon should depend
on `build`:

```jsonc
// turbo.json
{ "tasks": { "build": { "outputs": ["build/**"] }, "test": { "dependsOn": ["build"] } } }
```

`node-addon-api` and `node-api-headers` are resolved from the project that is
being built before this package's own copies, so hoisting them to the
workspace root is fine.

---

## Continuous integration

Cache `~/.zig-build` and the build is fast after the first run.

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.zig-build
    key: zig-native-build-${{ runner.os }}-${{ hashFiles('**/build.zig.zon') }}

- run: npm ci
- run: npm run build
```

No `setup-python`, no MSVC step, no `apt-get install build-essential`.

To build every platform's artifact from one Linux runner, use `--target`
several times instead of a matrix. macOS and Windows binaries come out of a
Linux job unchanged — only the platform's own *tests* need that platform's
runner.

For a hermetic build, pin the toolchain and forbid downloads after a warm-up:

```bash
zig-native-build --zig-version 0.15.2 --node-version 22.11.0
zig-native-build --offline        # fails rather than reaching the network
```

---

## Examples

Each directory is a complete, working project.

| Example | Shows |
|---|---|
| [`01-minimal-c-addon`](examples/01-minimal-c-addon) | the smallest useful addon: plain C, four-line `build.zig` |
| [`02-cpp-node-addon-api`](examples/02-cpp-node-addon-api) | C++ with `node-addon-api`, exceptions crossing into JS |
| [`03-library-cli-and-addon`](examples/03-library-cli-and-addon) | one core library behind an addon, a static library and a CLI, plus a `third_party/` file drop with its own flags |
| [`04-zig-package-dependency`](examples/04-zig-package-dependency) | linking zstd as a Zig package — nothing vendored |

To run them from a clone of this repository:

```bash
node lib/cli.js build --root examples/01-minimal-c-addon
cd examples/01-minimal-c-addon && node --test
```

---

## Porting an existing Zig build

If you already drive `zig build` from a hand-written `build.zig`, the move is
mostly deletion. Two real modules, ported in full, for scale:

### A C library with C++ bindings, a vendored library and a package dependency

Roughly 200 lines of `build.zig` — recursive source walking, N-API include
paths, Windows import-library generation, the `.node` install step, a
`compile_commands.json` step, AVX512 detection — became this:

```zig
const std = @import("std");
const znb = @import("zig_native_build");

pub fn build(b: *std.Build) !void {
    const addon = try znb.addNodeAddon(b, .{ .name = "geosearch_native" });

    // A package dependency whose headers it does not install itself.
    addon.linkDependency("blockchain_core", "gradido_blockchain_core");
    addon.addDependencyIncludePath("blockchain_core", "include");

    // CRoaring, vendored under third_party/. No warning flags — its SIMD
    // headers do not survive them — and AVX512 off unless the CPU has it.
    addon.addSources(.{
        .dir = "third_party/roaring",
        .files = &.{"roaring.c"},
        .warnings = false,
        .flags = if (hasAvx512(addon.target)) &.{} else &.{"-DCROARING_COMPILER_SUPPORTS_AVX512=0"},
    });
}

fn hasAvx512(target: std.Build.ResolvedTarget) bool {
    if (target.result.cpu.arch != .x86_64) return false;
    const features = target.result.cpu.features;
    return features.isEnabled(@intFromEnum(std.Target.x86.Feature.avx512f)) and
        features.isEnabled(@intFromEnum(std.Target.x86.Feature.avx512dq)) and
        features.isEnabled(@intFromEnum(std.Target.x86.Feature.avx512bw));
}
```

### A crypto module with a non-standard layout

```zig
const std = @import("std");
const znb = @import("zig_native_build");

pub fn build(b: *std.Build) !void {
    const addon = try znb.addNodeAddon(b, .{
        .name = "shared_native",
        // third_party/ is compiled here as well as included, and its warnings
        // are not this project's business.
        .sources = &.{
            .{ .dir = "src" },
            .{ .dir = "napi" },
            .{ .dir = "third_party", .warnings = false },
        },
        .include = &.{
            "include",
            "include/gradido_blockchain_core/data/proto/gradido",
            "third_party",
            "third_party/pbtools",
        },
        .defines = &.{.{ .name = "USE_SODIUM" }},
    });

    // libsodium builds a static and a shared artifact, so the choice has to be
    // made explicitly or the artifact name is ambiguous.
    addon.linkDependencyWith(
        "libsodium",
        if (addon.target.result.os.tag == .windows) "libsodium-static" else "sodium",
        .{ .static = true, .shared = false },
    );
}
```

Both produce a `.node` within a kilobyte of what their old build files
produced, with the same exports.

### The steps

1. `npm i -D zig-native-build`
2. Add the template to `build.zig.zon`, keeping your existing dependencies:
   ```zig
   .dependencies = .{
       .zig_native_build = .{ .path = ".zig-native" },
       // ...yours, unchanged
   },
   ```
3. Rewrite `build.zig` as above.
4. Delete the `zig_compile_commands` dependency — the template brings its own
   generator, so that entry is no longer needed.
5. Replace the build script in `package.json` with `zig-native-build`, and
   delete the helper that used to drive Zig.
6. A dependency you link with `linkDependency` must not be `.lazy = true`.
   Drop the flag, or resolve it yourself with `b.lazyDependency`.

---

## Coming from node-gyp

| node-gyp | here |
|---|---|
| `binding.gyp` | `build.zig` |
| `sources: [...]` | nothing — directories are walked |
| `include_dirs` | `.include` |
| `defines` | `.defines` |
| `cflags` / `cflags_cc` | `.flags` / `.c_flags` / `.cpp_flags` |
| `dependencies` | `.linkDependency(...)` or `addSources` |
| `<!(node -p "require('node-addon-api').include")` | automatic |
| `build/Release/addon.node` | `build/addon.node` |
| a system compiler per platform | one downloaded toolchain for all of them |
| `prebuild` / `prebuildify` for other platforms | `--target` |

The C and C++ sources themselves need no changes: `node_api.h` and `napi.h` are
the same headers.

What you give up: `binding.gyp` conditionals (`'conditions'`) have no direct
equivalent — use Zig's `if (target.result.os.tag == .windows)` in `build.zig`,
which is a real language and rather more readable.

---

## Troubleshooting

**`no build.zig.zon in <dir>`**
Run `zig-native-build init`.

**`build.zig.zon does not declare the build template`**
Add this to its `.dependencies`:
```zig
.zig_native_build = .{ .path = ".zig-native" },
```

**`invalid fingerprint: 0x…; if this is a new or forked package, use this value: 0x…`**
Zig computes the fingerprint from the package name. Paste the value it prints
into `build.zig.zon`.

**`source directory 'napi' does not exist`**
Either create it, remove it from `.sources`, or mark the set
`.optional = true`.

**`no Node headers were provided`**
`build.zig` was run directly instead of through the CLI. Either use
`zig-native-build`, or pass `-Dnode-headers=<dir>` yourself.

**`undefined symbol: _napi_…` when cross compiling to macOS**
This should not happen — the template sets the flag that allows it. If you
replaced `addNodeAddon` with a hand-written compile step, set
`compile.linker_allow_shlib_undefined = true` for macOS targets.

**`building a Windows addon needs an import library`**
Only when you run `zig build` by hand. Through the CLI, `node.lib` is
downloaded automatically.

**The addon does not reflect my changes**
`zig-native-build clean` then build again. If that fixes it, the build cache
went stale — please report it.

**Behind a proxy or an air-gapped network**
Set `ZIG_MIRROR` and `NODEJS_ORG_MIRROR` to internal mirrors, or pre-populate
`~/.zig-build` and build with `--offline`.

**`zig-native-build info`** prints every resolved path and version. It is the
first thing to run when a build behaves unexpectedly.

---

## Reference

### Node API

```js
import { build, clean, info, zig, defineConfig } from 'zig-native-build'

await build({ root: 'packages/native', optimize: 'fast' })
await build({ targets: ['x86_64-linux-gnu', 'aarch64-macos'] })
await clean()
await info()
await zig(['fmt', '--check', 'build.zig'])
```

Full types are in [`index.d.ts`](index.d.ts).

### Linting

The JavaScript is checked and formatted with [Biome](https://biomejs.dev),
configured to match the projects this package was written for.

```bash
npm run lint          # check
npm run lint:fix      # check and fix
npm run fmt:check     # the same for the Zig sources, via zig fmt
```

### Zig version

The package targets **Zig 0.15.2**. Zig's build API is not yet stable, so a
different release may need a different template; pin with `--zig-version` or
`zigVersion` and upgrade deliberately.

### Renaming this package

Everything is one name in `package.json` plus the Zig dependency key
`zig_native_build` in `zig/build.zig.zon` and in the scaffolder. To publish
under a scope, change `"name"` in `package.json` only — the Zig side is
independent of it.

---

## License

Apache-2.0.

The idea of driving a Zig cross-compile from a small Node script, and the shape
of its target description, were taken from
[`@solarwinds/zig-build`](https://github.com/solarwinds/apm-js) (MIT). No code
from it is reproduced here.
