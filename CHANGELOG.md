# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [semantic versioning](https://semver.org).

The Zig template in `zig/` counts as part of the public interface: a change to
it that an existing project would have to react to is a breaking change, not a
patch.

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

[0.2.0]: https://github.com/gradido/c_cpp_zig_build/releases/tag/v0.2.0
[0.1.0]: https://github.com/gradido/c_cpp_zig_build/releases/tag/v0.1.0
