# AGENTS.md — building a native C/C++ module with `zig-native-build`

Guidance for coding agents working in a project that builds a native Node.js
module with this package. Copy this file into such a project (or link to it)
so an agent has the conventions to hand.

If you are working *on* `zig-native-build` itself, read
[the maintainer section](#working-on-zig-native-build-itself) at the end.

---

## The one-paragraph version

C and C++ sources live in `src/`, Node-API bindings in `napi/`, public headers
in `include/`, vendored libraries in `third_party/`. Every `.c` and `.cpp` file
under `src/` and `napi/` is compiled automatically — there is no file list to
maintain. `build.zig` says what to build and is usually four lines. Build with
`npm run build` (or `bun run build` / `yarn build` / `pnpm build`); never invoke
a compiler directly. The Zig toolchain and the Node headers are downloaded on
first build; nothing needs to be installed.

---

## Commands

```bash
npm run build                       # build (ReleaseSmall by default)
npm run lint                        # biome, if the project uses it
npx zig-native-build --debug        # a debug build, with assertions
npx zig-native-build --verbose      # print the exact compiler command lines
npx zig-native-build info           # every resolved path, version and target
npx zig-native-build clean          # remove build/, .zig-cache/, .zig-native/
npx zig-native-build --target aarch64-macos   # cross compile
npx zig-native-build zig -- <args>  # run the managed Zig toolchain
```

Substitute your package manager's runner for `npx` (`bunx`, `yarn dlx`,
`pnpm exec`) — the tool is the same.

**When a build fails, run `npx zig-native-build info` first.** It prints which
Zig, which Node headers, which target and which output directory are in play,
and most confusing failures are explained by one of those being unexpected.

---

## Where code goes

| Directory | Contents | Compiled? |
|---|---|---|
| `src/` | the library — the actual logic | yes, recursively |
| `napi/` | Node-API bindings, nothing else | yes, recursively |
| `include/` | public headers | no, but on the include path |
| `third_party/` | vendored libraries | only when `build.zig` says so |
| `build/` | output — **generated, never edit** | — |
| `.zig-native/` | the build template — **generated, never edit** | — |

### Adding a source file

Create it under `src/` and build. That is the whole procedure — do **not** add
it to a list anywhere, because there is no list. The same is true for
subdirectories: the walk is recursive.

### Adding a binding

Bindings may be C (`#include <node_api.h>`) or C++ (`#include <napi.h>`).
Both headers are available without the project installing anything:
`zig-native-build` downloads the Node headers and depends on `node-addon-api`.
Declare `node-addon-api` in the project's package.json when the version
matters — the declared one wins.

Put it in `napi/`, and keep it thin. A binding should convert JavaScript values
to C types, call a function in `src/`, and convert the result back. Logic in
`napi/` cannot be tested or profiled without a JavaScript runtime, which is the
whole reason for the split.

```c
/* napi/binding.c — the shape to follow */
#include <node_api.h>
#include "thing.h"          /* from include/ */

static napi_value Thing(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "thing(x) expects one argument");
    return NULL;                        /* returning NULL with a pending
                                           exception is how you throw */
  }

  int64_t x = 0;
  napi_get_value_int64(env, argv[0], &x);

  napi_value result;
  napi_create_int64(env, thing_compute(x), &result);   /* the work is in src/ */
  return result;
}
```

---

## Editing `build.zig`

The whole file is often this:

```zig
const std = @import("std");
const znb = @import("zig_native_build");

pub fn build(b: *std.Build) !void {
    _ = try znb.addNodeAddon(b, .{ .name = "my_native" });
}
```

Change it when, and only when, one of these is true:

| Situation | What to add |
|---|---|
| a C or C++ standard is required | `.c_std = "c17"`, `.cpp_std = "c++20"` |
| a macro is needed everywhere | `.defines = &.{ .{ .name = "FOO", .value = "1" } }` |
| sources live somewhere other than `src/` and `napi/` | `.sources = &.{ .{ .dir = "lib" } }` |
| a header directory is elsewhere | `.include = &.{ "include", "vendor/inc" }` |
| a vendored file needs its own flag | `artifact.addSources(.{ .dir = "…", .files = &.{"…"}, .flags = &.{"-D…"} })` |
| a vendored library warns or fails on `-W…` | add `.warnings = false` to its source set |
| a Zig package is being linked | `artifact.linkDependency("dep", "artifact")` |
| that package takes build options | `artifact.linkDependencyWith("dep", "artifact", .{ .static = true })` |
| a system library is needed | `artifact.linkSystemLibrary("pthread")` |
| the same code should also be a CLI or static library | a second `znb.addExecutable` / `addStaticLibrary` call |

Everything else — libc, libc++, the Node headers, the `.node` extension, the
Windows import library, `compile_commands.json` — is handled and should not be
added by hand.

**The escape hatch.** `artifact.compile` is an ordinary
`*std.Build.Step.Compile`. Anything Zig can do to a compile step can be done to
it. Reach for that before working around the template.

---

## Adding a dependency

In this order of preference:

### 1. A Zig package

```bash
npx zig-native-build zig -- fetch --save https://github.com/allyourcodebase/zstd/archive/refs/tags/1.5.7-2.tar.gz
```

This edits `build.zig.zon` for you — do not write the `.hash` by hand, it will
be wrong. Then in `build.zig`:

```zig
const addon = try znb.addNodeAddon(b, .{ .name = "my_native" });
addon.linkDependency("zstd", "zstd");
```

The first argument is the key in `build.zig.zon`, the second is the artifact
name the package installs. When unsure of the artifact name, read the
dependency's own `build.zig` — look for `b.addLibrary(.{ .name = … })`.

### 2. A file drop in `third_party/`

Unpack the library there. Its headers are on the include path immediately.
To compile it:

```zig
addon.addSources(.{ .dir = "third_party/thelib", .exclude = &.{ "test/", "examples/" } });
addon.addIncludePath("third_party/thelib/include");
```

### 3. A git submodule

Same as a file drop from the build's point of view. Remember that CI needs
`git submodule update --init --recursive`.

**Never** add a dependency by committing prebuilt `.a`, `.so`, `.dll` or `.lib`
files. They defeat cross compilation and will break the first time someone
builds for another platform.

A dependency linked with `linkDependency` must not be marked `.lazy = true` in
`build.zig.zon` — lazy dependencies are only reachable through
`b.lazyDependency`, which returns null until Zig has fetched them.

---

## Testing

Tests belong at two levels, and both are worth having:

**JavaScript tests** exercise the addon through its public interface:

```js
// test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import addon from './index.cjs'

test('computes the thing', () => {
  assert.equal(addon.thing(21), 42)
})
```

```bash
npm run build && node --test
```

Always build before testing — a stale `build/` is the most common cause of a
test that passes locally and fails in CI, or the reverse.

**C tests** exercise `src/` without a JavaScript runtime. Add an executable in
`build.zig` and run it as a step:

```zig
const tests = try znb.addExecutable(b, .{
    .name = "test_thing",
    .sources = &.{ .{ .dir = "src" }, .{ .dir = "tests" } },
});
const run = b.addRunArtifact(tests.compile);
b.step("test", "Run the C tests").dependOn(&run.step);
```

```bash
npx zig-native-build --step test
```

---

## Rules

**Do not edit generated files.** `.zig-native/` is overwritten on every build,
and `build/` on every compile. A change in either is lost without warning. If
something in `.zig-native/` needs to change, the change belongs in the
`zig-native-build` package.

**Do not add a system compiler.** No `gcc`, `clang`, `cl.exe`, `make`,
`CMakeLists.txt` or `binding.gyp`. Zig is the toolchain; a second one defeats
the point and will not be reproducible on another machine.

**Do not commit build output.** `build/`, `.zig-cache/`, `.zig-native/` and
`compile_commands.json` belong in `.gitignore`.

**Do not hand-write `.hash` values** in `build.zig.zon`. Use
`zig-native-build zig -- fetch --save`.

**Do not pin the artifact name in two places.** The name in
`build.zig` decides the output file; `index.cjs` must load exactly that name.

**Prefer `--debug` while investigating.** The default is `ReleaseSmall`, which
strips assertions and makes stack traces useless. A crash reproduced under
`--debug` is a crash you can read.

---

## Node-API conventions worth following

- Check every `napi_*` return value. They fail, and ignoring the failure turns
  a clear error into a segfault.
- Return `NULL` from a callback **only** with a pending exception. Returning
  `NULL` without throwing produces `undefined` and hides the bug.
- Values above 2^53 must cross as `BigInt` (`napi_create_bigint_uint64`), not
  as `napi_create_double` — a hash or a 64-bit id silently loses precision
  otherwise.
- `napi_get_buffer_info` borrows; `napi_get_value_string_utf8` copies and you
  own the memory. Free what you allocate on every path, including the error
  ones.
- A C++ exception must not cross into JavaScript. Catch it and throw a
  `Napi::Error`, or the process goes down.
- `NAPI_VERSION` is set to 8 by the build. Raising it costs compatibility with
  older Node versions; do not raise it casually.

---

## Common errors

| Message | Cause and fix |
|---|---|
| `no build.zig.zon in <dir>` | not set up yet — run `zig-native-build init` |
| `build.zig.zon does not declare the build template` | add `.zig_native_build = .{ .path = ".zig-native" },` to `.dependencies` |
| `invalid fingerprint: 0x…; use this value: 0x…` | paste the printed value into `build.zig.zon` |
| `source directory 'napi' does not exist` | create it, drop it from `.sources`, or mark the set `.optional = true` |
| `no Node headers were provided` | `zig build` was run directly; use `zig-native-build` |
| `error: call to undeclared function` | a missing `#include` — Zig's C compiler is strict about C99 and later |
| `artifact name '…' is ambiguous` | the package builds several artifacts of that name; pick one with `linkDependencyWith(…, .{ .static = true, .shared = false })` |
| `static function '…' is used in an inline function with external linkage` | `-Wpedantic` on third-party code; set `.warnings = false` on that source set |
| `always_inline function '…' requires target feature` | a SIMD library compiled for a CPU without those features; pass the library's own "disable" define in the source set's `flags` |
| `undefined symbol: napi_…` at load time | the addon was built for another Node-API version, or is stale — rebuild |
| `Cannot find module './build/x.node'` | not built yet, or `index.cjs` names a different file than `build.zig` does |
| the addon loads but is missing an export | the `napi_define_properties` count argument does not match the array length |

---

## Working on `zig-native-build` itself

```
lib/                JavaScript side (ESM, no build step)
  cli.js            argument parsing and command dispatch
  index.js          build / clean / info / zig
  config.js         defaults, config files, auto-detection
  zig.js            toolchain download, mirrors, checksum verification
  node-headers.js   Node headers, node.lib, node-addon-api discovery
  scaffold.js       the `init` command
  template.js       copying the Zig template into a project
  download.js       fetch, verify, extract, lock
  host.js           platform, musl, target triple, Node version
  proc.js  fsutil.js  log.js
zig/                the Zig template, copied into projects verbatim
  build.zig         the public API: addNodeAddon, addStaticLibrary, …
  src/sources.zig   recursive source collection
  src/napi.zig      Windows import libraries
  src/compile_commands.zig   the clangd database generator
examples/           four complete projects, all of which must keep building
tests/              node --test
scripts/            test-examples.mjs — builds and tests every example
index.d.ts          hand-written types for the JavaScript API
```

Ground rules:

- **The only runtime dependencies are `node-addon-api` and `node-api-headers`.**
  Both are header-only with no dependencies of their own, and both earn their
  place: they are what lets a C++ addon and a Windows or Bun build work with
  nothing installed in the project. Adding a third needs a reason of that
  weight — a build tool that breaks because a transitive dependency broke is a
  bad build tool.
- **Both are resolved from the consuming project first.** A project that pins
  its own `node-addon-api` compiles against that one; `zig-native-build info`
  reports which copy was used.
- **The JavaScript is plain ESM with no compile step.** Types live in
  `index.d.ts`, written by hand.
- **`zig/` must stay self-contained.** It carries its own
  `compile_commands.json` generator precisely so that a consuming project's
  `build.zig.zon` stays free for the project's own dependencies. Do not add a
  Zig dependency to it.
- **Every download is checksum-verified** against the publisher's own manifest,
  and extracted to a staging directory before being renamed into place. Keep
  both properties.
- **Zig's build API is unstable.** Changing the supported Zig version means
  re-testing every example, not just the unit tests.

Before proposing a change:

```bash
npm run lint
node --test tests/
for e in examples/*/; do node lib/cli.js build --root "$e" || break; done
(cd examples/01-minimal-c-addon && node --test)
(cd examples/02-cpp-node-addon-api && node --test)
(cd examples/03-library-cli-and-addon && node --test)
(cd examples/04-zig-package-dependency && node --test)
node lib/cli.js zig -- fmt --check zig/build.zig zig/src/
```
