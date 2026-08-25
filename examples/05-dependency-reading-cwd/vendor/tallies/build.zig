//! A package that lists its own sources through the working directory.
//!
//! This is the mistake, written on purpose. `std.fs.cwd()` is the directory the
//! `zig build` command was run from, which for a package built on its own is
//! also its own directory — so nothing here looks wrong until someone depends
//! on it, at which point `src` is looked for in *their* project.
//!
//! The right spelling is one word different, and every other build script in
//! this repository uses it:
//!
//!     var dir = try b.build_root.handle.openDir(root, .{ .iterate = true });
//!
//! It stays wrong here so that the template has something to prove itself
//! against. Do not copy this file.

const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addLibrary(.{
        .name = "tallies",
        .linkage = .static,
        .root_module = b.createModule(.{ .target = target, .optimize = optimize }),
    });

    lib.linkLibC();
    lib.addIncludePath(b.path("include"));
    lib.installHeader(b.path("include/tallies.h"), "tallies.h");
    try addDirSources(lib, b, "src");

    b.installArtifact(lib);
}

/// Every `.c` file under @p root, found the wrong way round. See the note above.
fn addDirSources(lib: *std.Build.Step.Compile, b: *std.Build, root: []const u8) !void {
    var dir = try std.fs.cwd().openDir(root, .{ .iterate = true });
    defer dir.close();

    var walker = try dir.walk(b.allocator);
    defer walker.deinit();

    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(b.allocator);

    while (try walker.next()) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.path, ".c")) continue;
        try files.append(b.allocator, b.dupe(entry.path));
    }

    lib.addCSourceFiles(.{ .root = b.path(root), .files = files.items });
}
