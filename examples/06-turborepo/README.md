# 06 — a turborepo, and whether the build outputs survive it

A two-package workspace driven by [turborepo](https://turbo.build). One package
is a native addon built by `c-cpp-zig-build`; the other is plain JavaScript
whose build step *calls* that addon. The example exists to answer one question,
and to keep answering it:

> When turbo reports a cache hit, is the compiled `.node` file actually there?

```
packages/checksum/   C addon → build/crc32_addon.node
packages/app/        build.mjs imports the addon and writes dist/manifest.json
turbo.json           the task graph, and the `outputs` that make this work
check-turbo-cache.mjs  the executable answer
```

## Run it

```bash
bun install        # or: npm install — turbo is a real dependency here
bun run build      # or: npm run build
bun run test       # or: npm test
```

`bun run test` runs each package's own tests through turbo and then
`check-turbo-cache.mjs`, which is where the interesting part is. To run only
that: `bun run check`.

## The answer

**Yes — provided `turbo.json` names the output directory.** A native addon is
the one build output people forget to declare, because it is the one nothing
else will ever recreate: no install step, no bundler, no `postinstall`. This is
the line that matters:

```json
"build": {
  "dependsOn": ["^build"],
  "outputs": ["build/**", "dist/**"]
}
```

With it, deleting `packages/checksum/build/` and running `turbo run build`
again restores a byte-identical `crc32_addon.node`, executable bit and all, in
about ten milliseconds. `check-turbo-cache.mjs` asserts exactly that: same
sha256, still loadable, still computing the right CRC.

**Without it, turbo lies to you — convincingly.** The task is still cached, and
on a hit turbo replays the logs, so you read

```
@turbo-example/checksum:build: cache hit, replaying logs
@turbo-example/checksum:build: [checksum] built …/packages/checksum/build
 Tasks:    1 successful, 1 total
  Time:    10ms >>> FULL TURBO
```

and the directory is empty. Nothing was cached, so nothing was restored; the
line saying the addon was built is a recording of a build that happened
yesterday. The failure surfaces later and somewhere else, as
`Cannot find module …/crc32_addon.node` in whatever runs next.

That is not a hypothetical here. `turbo.json` carries a second task,
`build:uncached`, which runs the identical compile into a different directory
and declares `"outputs": []`. The last check in `check-turbo-cache.mjs` builds
it, deletes the directory, replays it from cache and asserts that the output is
**gone** — so the trap stays demonstrated rather than described.

## Worth noticing

**The downstream package is the second line of defence.** `packages/app`'s
build step imports the addon and checksums its own source with it. If the
upstream outputs were not restored, that step does not produce something stale
— it fails outright, on every build, with an import error. Wiring a real
consumer into the graph is worth more than any assertion about file paths.

**`"ui": "stream"`.** turbo 2 defaults to an interactive TUI that repaints
task panes in place. It is pleasant to watch and useless to read afterwards:
compiler diagnostics scroll inside a pane and are gone. `stream` prefixes each
line with the task name and leaves it in the scrollback, which is what you want
the day a build breaks in CI.

**`inputs` are worth being explicit about.** By default turbo hashes every
git-tracked file in the package. `build/`, `.zig-cache/` and `.zig-native/` are
git-ignored, so they are excluded either way — but naming `src/**`, `napi/**`,
`include/**`, `build.zig` and `build.zig.zon` makes the cache key say what it
means, and stops a README edit from invalidating a C compile.

**What is *not* cached, and should not be.** `.zig-cache/` is Zig's own
incremental cache and `.zig-native/` is the build template this tool writes.
Neither belongs in `outputs`: they are inputs to a faster rebuild, not
artifacts, and Zig manages their lifetime itself. Only `build/` is the product.

**The toolchain is outside the cache key.** `c-cpp-zig-build` downloads Zig
into `~/.zig-build`, which turbo neither hashes nor caches. Pinning
`zigVersion` in a config file — or letting the bundled default do it — is what
keeps a cache hit on one machine meaning the same bytes as on another. A global
`turbo.json` `env` or `globalDependencies` entry is the place to say so if you
pin it through the environment.

**Cross compiling is per-target output.** `--target aarch64-macos --target
x86_64-windows` writes `build/<triple>/…` rather than `build/…`, so
`"outputs": ["build/**"]` already covers it. A task that builds one target per
turbo task wants the triple in the output glob instead.
