const std = @import("std");
const znb = @import("zig_native_build");

pub fn build(b: *std.Build) !void {
    // There is no src/ here: everything this addon does comes from a package.
    const addon = try znb.addNodeAddon(b, .{
        .name = "zstd_addon",
        .sources = &.{.{ .dir = "napi" }},
    });

    // zstd was added with:
    //   zig-native-build zig -- fetch --save \
    //     https://github.com/allyourcodebase/zstd/archive/refs/tags/1.5.7-2.tar.gz
    //
    // linkDependency resolves the package with this artifact's target and
    // optimisation mode, so a cross build cross-builds the dependency too.
    addon.linkDependency("zstd", "zstd");
}
