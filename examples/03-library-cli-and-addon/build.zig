const std = @import("std");
const znb = @import("zig_native_build");

/// The vendored library under third_party/. It is compiled into every
/// artifact that needs it, with one define of its own — which is why it is a
/// separate source set rather than part of the default `src/` walk.
const fasthash: znb.SourceSet = .{
    .dir = "third_party/fasthash",
    .flags = &.{"-DFASTHASH_SEED=0xcbf29ce484222325ULL"},
};

pub fn build(b: *std.Build) !void {
    // 1. The Node addon: src/ + napi/, installed as digest_addon.node.
    const addon = try znb.addNodeAddon(b, .{ .name = "digest_addon" });
    addon.addSources(fasthash);
    addon.addIncludePath("third_party/fasthash");

    // 2. The same core as a static library, for anything that links C.
    const lib = try znb.addStaticLibrary(b, .{
        .name = "digest",
        // Only src/: the bindings belong to the addon, not to the library.
        .sources = &.{.{ .dir = "src" }},
    });
    lib.addSources(fasthash);
    lib.addIncludePath("third_party/fasthash");

    // 3. A command line tool over the same core, so the logic can be run
    //    without a JavaScript runtime in the way.
    const cli = try znb.addExecutable(b, .{
        .name = "digest",
        .sources = &.{ .{ .dir = "src" }, .{ .dir = "cli" } },
    });
    cli.addSources(fasthash);
    cli.addIncludePath("third_party/fasthash");

    // `zig-native-build --step run -- <file>` runs it in place.
    const run = b.addRunArtifact(cli.compile);
    run.step.dependOn(b.getInstallStep());
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the digest tool").dependOn(&run.step);
}
