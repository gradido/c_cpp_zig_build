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

## Running it again

A second `bun run build` is a cache hit, which is the point — but it also means
you cannot watch the first one twice. `bun run clear` puts the workspace back
to how it comes out of a clone:

```bash
bun run clear              # turbo's cache, and everything the build wrote
bun run clear --toolchain  # and the downloaded Zig, to see that happen again
```

It removes derived output only, and needs neither turbo nor the build tool to
be working — which matters, because the state you most want to reset is the one
left by something that broke. `node_modules` stays: reinstalling turbo is not
what makes a run cold. `--toolchain` reaches outside the workspace into
`~/.zig-build`, which every project on the machine shares, so it takes a flag
rather than being the default.

[`clear.mjs`](clear.mjs) is worth a glance on its own: the list of paths in it
is the complete inventory of what a turborepo build with a native addon leaves
behind. Two of its decisions were learned the hard way on Windows:

- **`.turbo/cache`, not all of `.turbo`.** The daemon keeps its log files in
  `.turbo/daemon` and holds them open; removing those fails with `EPERM` or
  `ENOTEMPTY` and takes the script down with it. They also have nothing to do
  with whether the next run is cold — the cache does.
- **A file that cannot be removed is reported, not thrown.** You get the path,
  the reason, and a non-zero exit, rather than a stack trace out of
  `node:internal/fs/rimraf`.

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

**The toolchain download reports as five log lines here, not as a bar.** Run
directly, `c-cpp-zig-build` draws a bar that repaints in place and disappears
when the download ends. Under turbo it cannot: a repainting bar needs a terminal
it owns, and turbo writes its own prefixed lines there whenever it pleases — a
bar repainting between them overwrites them, and the erase at the end takes
whatever shared the line. Zig's own progress display comes to the same
conclusion and switches itself off when it is not in charge of the terminal. So
a supervised build gets one line per fifth of the download instead, which is
correct whether you are watching live or reading the log afterwards.

**`"ui": "stream"`.** turbo 2 defaults to an interactive TUI that repaints
task panes in place. It is pleasant to watch and useless to read afterwards:
compiler diagnostics scroll inside a pane and are gone. `stream` prefixes each
line with the task name and leaves it in the scrollback, which is what you want
the day a build breaks in CI.

**turbo strips the environment.** By default a task sees only the variables
turbo knows about — `NO_COLOR` gets through, `C_CPP_ZIG_BUILD_HOME` does not,
which would silently move the toolchain cache back to the default without
saying so. Anything the build tool reads has to be declared:

```json
"globalEnv": ["ZIG_EXE"],
"globalPassThroughEnv": ["C_CPP_ZIG_BUILD_HOME", "ZIG_MIRROR", ...]
```

Which list a variable goes in is the interesting part, and it is decided by one
question: **does it change what gets compiled?**

`ZIG_EXE` replaces the managed toolchain with a compiler of your own, so it
does — a different Zig can emit different code, and a build made with one must
not be served from the cache to a build asking for the other. Variables in
`globalEnv` are hashed, so setting it produces a cache miss.

`C_CPP_ZIG_BUILD_HOME` and `ZIG_MIRROR` only move *where* the same, checksum-
verified toolchain is fetched from and cached. Hashing those would throw away
everything already built for no reason, so they go in `globalPassThroughEnv`,
which reaches the task without entering the cache key. `NO_COLOR` and
`C_CPP_ZIG_BUILD_PROGRESS` are the same story: output, not artifacts.

Both lists have per-task counterparts, `env` and `passThroughEnv`. The
root-level form fits here because the toolchain is a property of the machine
rather than of one package.

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
