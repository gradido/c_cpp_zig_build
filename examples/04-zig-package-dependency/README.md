# 04 — a Zig package dependency

An addon over [zstd](https://facebook.github.io/zstd/), with no zstd source in
this repository. There is no `src/` either: everything the addon does comes
from the package.

```zig
const addon = try znb.addNodeAddon(b, .{
    .name = "zstd_addon",
    .sources = &.{.{ .dir = "napi" }},
});
addon.linkDependency("zstd", "zstd");
```

The dependency was added with one command:

```bash
npx zig-native-build zig -- fetch --save \
  https://github.com/allyourcodebase/zstd/archive/refs/tags/1.5.7-2.tar.gz
```

That wrote the URL and its hash into `build.zig.zon`. `zig` here is the
toolchain `zig-native-build` manages, so there is nothing to install first.

```bash
npm run build     # fetches zstd on the first run, then never again
node --test
```

## Worth noticing

**`linkDependency` takes the dependency name and the artifact name.** The
first is the key in `build.zig.zon`; the second is what the package's own
`build.zig` calls the library. When in doubt, read that file and look for
`b.addLibrary(.{ .name = … })`.

**Headers come with the link.** zstd installs its headers, so `#include
<zstd.h>` works with no include path added. Packages that do not install
theirs need one line more:

```zig
addon.addDependencyIncludePath("thelib", "include");
```

**Packages that take options** are linked with `linkDependencyWith`, which
matters when a package builds more than one artifact:

```zig
addon.linkDependencyWith("libsodium", "sodium", .{ .static = true, .shared = false });
```

**The dependency cross compiles with you.** `linkDependency` resolves the
package with this artifact's target and optimisation mode, so

```bash
npx zig-native-build --target aarch64-macos
```

builds zstd for aarch64-macos too. Nothing about that is special-cased — it is
the reason to prefer a package over a vendored binary.

**Many C libraries already have one.**
[github.com/allyourcodebase](https://github.com/allyourcodebase) packages a
large number of them.
