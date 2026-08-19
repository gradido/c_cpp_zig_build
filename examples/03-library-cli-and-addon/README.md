# 03 — one core, three artifacts

The layout that pays off on any module bigger than a few functions: the logic
lives in a plain C library, and the Node addon is one of several things built
on top of it.

```
include/digest.h              the core interface
src/digest.c                  the core — no Node.js anywhere in it
napi/binding.c                the Node-API layer
cli/main.c                    a command line tool over the same core
third_party/fasthash/         a vendored library, dropped in
```

One `build.zig` produces all three:

| Artifact | Sources | Output |
|---|---|---|
| Node addon | `src/` + `napi/` + `third_party/fasthash` | `build/digest_addon.node` |
| static library | `src/` + `third_party/fasthash` | `build/lib/libdigest.a` |
| CLI | `src/` + `cli/` + `third_party/fasthash` | `build/bin/digest` |

```bash
npm run build
node --test                                  # the addon
./build/bin/digest package.json              # the CLI
npx zig-native-build --step run -- package.json   # the CLI, via zig build
```

All three give the same answer for the same input, because they are the same
code.

## Worth noticing

**A shared source set.** `third_party/fasthash` is declared once as a
`SourceSet` constant and handed to each artifact:

```zig
const fasthash: znb.SourceSet = .{
    .dir = "third_party/fasthash",
    .flags = &.{"-DFASTHASH_SEED=0xcbf29ce484222325ULL"},
};
```

A set's `flags` are added to the artifact's, so this gets the project's
warnings *and* its own define. A vendored library that does not survive
`-Wall` would add `.warnings = false` here.

**The file drop.** `third_party/fasthash` was created by copying two files in.
No list was edited: the directory is walked, and `include/` and `third_party/`
are on the header search path by default. Unpacking a real library, or adding
one as a git submodule, works exactly the same way.

**Why the CLI is worth having.** `digest_measure` can be run under a debugger,
a profiler or valgrind without a JavaScript runtime in the picture. When the
addon misbehaves, the first question is whether the CLI does too — and that
question is much faster to answer.

**`.sources` overrides the default.** The static library is built from `src/`
alone, because the bindings belong to the addon:

```zig
const lib = try znb.addStaticLibrary(b, .{
    .name = "digest",
    .sources = &.{.{ .dir = "src" }},
});
```
