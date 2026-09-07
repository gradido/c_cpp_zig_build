# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [semantic versioning](https://semver.org).

The Zig template in `zig/` counts as part of the public interface: a change to
it that an existing project would have to react to is a breaking change, not a
patch.

## [0.3.0] - 2026-09-07

Nothing is downloaded from nodejs.org any more — not the headers, not
`node.lib`. Addons compile against the `node-api-headers` package that ships
with this one, and on Windows the import library is generated from that
package's module definition file. The Zig toolchain is the only download left,
served by a community mirror or by ziglang.org, which in either case also
supplies the index and signature the archive is checked against. That fixes a
Windows build that could not start at all, and it removes direct V8 access —
which a Node-API addon should not have been reaching for anyway.

**Upgrading.** Nothing to change for an addon that includes `node_api.h` or
uses `node-addon-api`. Three things can bite: an addon that includes `v8.h`,
`node.h` or `uv.h` stops compiling; `--node-version` is now an unknown option;
and a `build.zig` driven by hand with `-Dnode-lib=` stops recognising it.

### Fixed

- **A Windows without bsdtar could not unpack the toolchain from a path with a
  bracket or a quote in it.** The zip fallback interpolated both paths into a
  single-quoted PowerShell literal, which a path like `C:\Users\O'Brien\…`
  closes early, and passed the archive to `Expand-Archive -Path`, which reads
  its value as a wildcard pattern. Both paths now travel in the environment,
  and the unpacking goes through `ZipFile::ExtractToDirectory`, which takes
  plain strings — `Expand-Archive` has no literal form for its destination, so
  a bracket there could not be fixed any other way.

- **The first build on Windows failed in Git Bash and MSYS2.** Unpacking the
  Zig toolchain went through whatever `tar` was on `PATH`, on the assumption
  that this is the bsdtar Windows 10 1803 and later ship. In a Git Bash or
  MSYS2 shell it is not: those put their own **GNU tar** first, and GNU tar
  gets the Zig zip wrong twice over. It reads `C:\...` as the old `host:path`
  rsh syntax and tries to open a network connection —

  ```
  tar: Cannot connect to C: resolve failed
  'tar -xf C:\Users\…\zig-x86_64-windows-0.15.2.zip …' exited with code 128
  ```

  — and even with a path it accepts, it cannot read a zip at all. The extractor
  now identifies which `tar` it found before trusting it with either: bsdtar is
  used as before, and where `PATH` yields GNU tar the bsdtar in `System32` is
  used instead, falling back to PowerShell's `Expand-Archive` on Windows older
  than 1803. GNU tar keeps the tarballs on macOS and Linux, now with
  `--force-local` on Windows paths.
- **A Windows build needs one download less.** The Node header tarball was the
  only `.tar.gz` this tool unpacked, and it is gone with the header download
  below.

- **A build interrupted with Ctrl+C no longer wedges the next one.** The
  download lock was removed in a `finally`, which Ctrl+C does not run, so an
  interrupted first build left its lock behind — and the next build then waited
  on it for ten minutes with no output and no CPU, which reads as a hang rather
  than as waiting. The lock now records its owner's pid and is taken over at
  once when that process is gone, waiting is announced with the path to delete
  if the answer is wrong, and SIGINT and SIGTERM release it on the way out.

### Changed

- **`node-api-headers` is the only source of Node-API headers.** It is a
  dependency of this package, so it is always present, it is versioned by npm
  rather than by whichever Node happens to be running, and nothing is
  downloaded or unpacked to get at it. A first build is one download shorter,
  and no build depends on nodejs.org being reachable.
- **Windows always builds its import library locally**, with `zig dlltool` from
  `node_api.def`. That was already the preferred route; now it is the only one.
  It is also the only route that can serve **Bun**, whose Node-API exports live
  in `bun.exe` rather than `node.exe` — so a Windows target cross compiles from
  a warm cache with no network at all.
- **`--node-headers` takes a directory, and only a directory.** The `auto`,
  `download` and `package` modes are gone with the download they selected, and
  the path form is now checked: a missing directory, or one without
  `node_api.h` in it, is an error rather than a silent fall back to the bundled
  headers.
- `c-cpp-zig-build info` reports the header directory it would use and where it
  came from, as `node-api-headers <version>` or `configured`.
- **The first build says when it is unpacking.** The download's progress bar
  erases itself when it completes, and unpacking 50-90 MB took long enough that
  the silence after it read as a hang.
- **The progress bar no longer depends on the mirror.** The archive size comes
  from the Zig index, so a community mirror that sends no `Content-Length` —
  or streams the archive chunked, where it cannot — still gets a bar instead of
  a plain megabyte counter.
- **The download bar behaves under turbo**, and under anything else that
  captures a task's output. It is a live line that repaints while the download
  runs and disappears when it ends — the same bar as a plain terminal run, not
  a column of stale percentages left in the log.

Under turbo or in CI it is five log lines instead, one per fifth of the
  download. A repainting bar needs a terminal it can own, and there nothing
  does: the supervisor writes its own lines whenever it pleases, a bar
  repainting between them overwrites them, and its closing erase takes whatever
  shared the line. Zig's own progress display reaches the same conclusion and
  switches itself off when it is not in charge of the terminal.

  The line form used to be a wall-clock throttle, which on a fast link gave two
  lines for a 90 MB download, the first of them `0%`. Repainting is now
  throttled to 80 ms with a fifth of a second of silence first, so a short
  download never flashes a bar and a long one costs tens of writes rather than
  thousands. `NO_COLOR`, or `C_CPP_ZIG_BUILD_PROGRESS=lines`, forces the line
  form everywhere; `off` silences it.

### Removed

- **The Node header tarball download, and with it `v8.h`, `node.h` and `uv.h`.**
  `node-api-headers` carries the Node-API and nothing else. An addon reaching
  past it into V8 is pinned to one Node build in the way Node-API exists to
  avoid — but if you need those headers, supply them yourself:

  ```bash
  c-cpp-zig-build --node-headers /path/to/node/include/node
  ```

  The directory is used verbatim, so a full Node header set works exactly as
  before.
- **The `node.lib` download, and the template's `-Dnode-lib` option.** This is a
  breaking change to the Zig template, which is why this is not a patch
  release: a `build.zig` invoked by hand with `-Dnode-lib=<path>` now fails with
  `error: invalid option: -Dnode-lib`. Through the CLI nothing changes. To link
  a real `node.lib`, add it to the compile step yourself — what `addNodeAddon`
  returns is a plain `std.Build.Step.Compile`.
- **`--node-version`, `nodeVersion` and the `.nvmrc` lookup behind them.** The
  setting chose the header download, then the `node.lib` download, and both are
  gone. The flag is now `unknown option '--node-version'`; `nodeVersion` in a
  config file or in package.json's `zigNative` block is ignored; `info` no
  longer prints a `node version` row; and `resolveConfig` no longer returns one.
  `--napi-version` was doing the real work all along: it sets `NAPI_VERSION`,
  which decides what the headers expose and therefore which runtimes the addon
  loads in.
- `NODEJS_ORG_MIRROR`, which had nothing left to point at.
- The `NodeHeadersMode` type in `index.d.ts`. `Config.nodeHeaders` is now
  `string | undefined`.

### Added

- **`npm run test:windows`**, which cross compiles an addon for
  `x86_64-windows` and `aarch64-windows` and reads the result back: both are PE
  files, the Node addon's import table names `node.exe`, the Bun addon's names
  `bun.exe`, and neither reaches for a downloaded `node.lib`. The Windows link
  step is three pieces deep — a `.def` file, `zig dlltool`, the import library
  — and none of it ran on a Linux or macOS build, so a break in it used to
  surface only on somebody's Windows machine. On a Windows host the test also
  loads the addon and calls into it.
- **`examples/06-turborepo`**, a two-package turborepo whose build outputs are
  produced by this tool. It answers, as an executable check, whether a compiled
  `.node` file survives turbo's cache: it does, provided `turbo.json` names the
  directory under `outputs`. A second task in the same repository declares no
  outputs, so the failure — a cache hit that replays "built …" and restores
  nothing — stays demonstrated rather than described.
- Every example is now runnable with `npm run build` / `npm test` from its own
  directory, with nothing installed first. Their scripts call the checkout
  through a relative path, so an example always exercises the working tree
  rather than a published release.

## [0.2.1] - 2026-08-25

A dependency whose `build.zig` reads the working directory no longer brings the
build down. Nothing a project writes has to change.

### Fixed

- **A package is resolved with its own directory as the working directory.**
  A build script is meant to reach its own files through `b.path()` and
  `b.build_root.handle`; plenty of published ones reach for `std.fs.cwd()`
  instead, and standalone the two are the same directory, so nothing says
  otherwise until someone depends on the package. `zig build` never changes
  directory, so a dependency's build script ran with the *consumer's* project
  root current — and one that lists its sources with
  `std.fs.cwd().openDir("src")` then walked the consumer's `src/`, or panicked
  with `FileNotFound` where the consumer had none, before a single file was
  compiled.
  - The failure named a directory in the wrong project, and nothing a consumer
    could write reached the dependency to fix it.
  - `Artifact.dependency`, `linkDependency`, `linkDependencyWith` and
    `addDependencyIncludePath` all go through the new resolution, so an
    existing project gets it without changing a line.
  - The window is the `b.dependency()` call itself. Build scripts declare steps
    and nothing more, every step runs long afterwards, and the paths handed out
    in between are `LazyPath`s anchored to a package or absolute — none of them
    read while the directory is moved.
  - A dependency of the dependency is resolved with the dependency's directory
    current rather than its own, since it goes through Zig's `b.dependency()`
    rather than through the template's.

### Added

- **`czb.dependency(b, name, args)`**, the same resolution for a package a
  build script resolves by hand instead of through an artifact.
- **`examples/05-dependency-reading-cwd`**, which is the regression test: a
  local path dependency that makes the mistake on purpose, in a project with no
  `src/` of its own for it to land in. Its tests assert both halves of that
  fixture, so neither can be tidied away without the example saying so.

## [0.2.0] - 2026-08-19

The package was renamed in this release. Nothing was published under the old
name, so there is no upgrade path to document — but if you tried an early
checkout, everything below changed at once.

### Changed

- **Renamed to `c-cpp-zig-build`** (was `zig-native-build`). Five derived
  identifiers moved with it: the `bin` entries (`c-cpp-zig-build` and the short
  `czb`), the Zig package name and `build.zig.zon` dependency key
  (`c_cpp_zig_build`), the environment variables (`C_CPP_ZIG_BUILD_HOME`,
  `C_CPP_ZIG_BUILD_DEBUG`), and the Zig package fingerprint.
- `-Wpedantic` is no longer on by default. clang promotes several pedantic
  findings to hard errors, and real third-party C — CRoaring's SIMD headers
  among it — does not survive it. `-Wall -Wextra` remain on; opt back in with
  `.pedantic = true`.
- Zig downloads now try three community mirrors at random before falling back
  to ziglang.org, rather than one. The mirrors are volunteer-run, and with a
  single pick a bad draw sent every build to the official host.
- Dependencies are pinned to exact versions rather than ranges. For the header
  packages the headers decide what compiles; for the linter, one that moves
  under you turns an unrelated commit into a diff full of reformatting.

### Added

- **Minisign signature verification for the Zig toolchain.** Every downloaded
  archive is checked against the Zig project's Ed25519 key, pinned in this
  package, in addition to the existing SHA-256 check. The signature is what
  makes the community mirrors safe to use; it is always fetched from
  ziglang.org rather than from the mirror serving the archive. Disable with
  `--no-verify-signature` if you must.
- A download watchdog. A source that sends nothing for 15 seconds, stalls for
  30, or sustains less than 64 KiB/s is abandoned and the next one is tried —
  previously a mirror trickling at a few KiB/s would hold a build for the full
  15-minute timeout and look like a hang.
- Cached archives left behind by an interrupted run are re-checked against
  their published checksum before use, instead of being trusted on the
  strength of their file name. A file that fails any check is deleted rather
  than left for the next run to find.
- `node-addon-api` and `node-api-headers` as dependencies, so C++ bindings and
  Windows builds work with nothing installed in the consuming project. A
  version the project declares itself always wins over the bundled one, and
  `c-cpp-zig-build info` reports which copy was used.
- `SourceSet.warnings`, to compile a vendored library without the project's
  warning flags.
- `Artifact.linkDependencyWith` and `Artifact.dependency`, for packages that
  take build options — `libsodium`, which builds both a static and a shared
  artifact, cannot be linked without them.
- `--no-verify-signature`, and a `zig signature` row in `info` output.
- Biome as the linter and formatter, pinned to 2.5.9.
- A `CHANGELOG.md`, and a "What is verified" section in the README covering
  every check the tool performs.

### Fixed

- `nodeWindowsArch` accepted non-Windows target triples and returned a Windows
  directory for them.
- Download failures now name the URL they came from. With several mirrors in
  play, a bare `fetch failed` said nothing about which one to blame.
- The `compile_commands.json` generator emitted Zig's version-ranged target
  triple (`x86_64-linux.6.1...6.1-gnu.2.36`), which clang and clangd reject. It
  now emits a plain `x86_64-linux-gnu`.

## [0.1.0] - 2026-08-19

Initial version. Never published.

- Downloads and caches the Zig toolchain and the Node headers under
  `~/.zig-build`, verifying both against the publisher's checksums.
- A `build.zig` template that configures a Node-API addon, a static or shared
  library, or an executable from a name and a handful of optional parameters,
  walking `src/` and `napi/` for sources.
- Cross compilation to any triple Zig supports, several at once and in
  parallel.
- Windows import libraries, including the separate addon Bun needs there.
- `compile_commands.json` generation, implemented in the template so that a
  project's `build.zig.zon` stays free for its own dependencies.
- `init`, `build`, `clean`, `info` and `zig` commands, a JavaScript API, and
  four worked examples.

[0.3.0]: https://github.com/gradido/c_cpp_zig_build/releases/tag/v0.3.0
[0.2.1]: https://github.com/gradido/c_cpp_zig_build/releases/tag/v0.2.1
[0.2.0]: https://github.com/gradido/c_cpp_zig_build/releases/tag/v0.2.0
[0.1.0]: https://github.com/gradido/c_cpp_zig_build/releases/tag/v0.1.0
