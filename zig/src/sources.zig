//! Collecting source files from a directory tree.
//!
//! The point is that a project should be able to drop a file into `src/` (or
//! unpack a library into `third_party/`) and have it compiled, without editing
//! any build file. Listing files explicitly stays available for the cases
//! where a directory holds more than what should be built.

const std = @import("std");

/// File extensions treated as compilable translation units.
pub const default_extensions: []const []const u8 = &.{ ".c", ".cpp", ".cc", ".cxx", ".c++", ".m", ".mm", ".S", ".s" };

/// The extensions that make a translation unit C++ rather than C.
pub const cpp_extensions: []const []const u8 = &.{ ".cpp", ".cc", ".cxx", ".c++", ".mm" };

/// One group of source files that share a set of compiler flags.
pub const SourceSet = struct {
    /// Directory to walk, relative to the build root. `null` means the files
    /// below are relative to the build root itself.
    dir: ?[]const u8 = null,

    /// Explicit file list, relative to `dir`. When empty, `dir` is walked
    /// recursively and every file with a matching extension is compiled.
    files: []const []const u8 = &.{},

    /// Extensions considered when walking. Ignored when `files` is given.
    extensions: []const []const u8 = default_extensions,

    /// Any file whose path (relative to `dir`) contains one of these
    /// substrings is skipped. Useful for keeping tests or platform-specific
    /// sources out of a build.
    exclude: []const []const u8 = &.{},

    /// Compiler flags for this set alone, added on top of the artifact's.
    flags: []const []const u8 = &.{},

    /// Override the artifact's warning flags for this set. `false` drops
    /// `-Wall -Wextra` (and `-Wpedantic`, and `-Werror`) — which is what you
    /// want for a vendored library, whose warnings you cannot fix and whose
    /// authors did not ask for your opinion.
    warnings: ?bool = null,

    /// A missing directory is normally an error, because a silently empty
    /// build is worse than a loud one. Optional sets (`napi/` in a project
    /// that has no bindings yet) set this instead.
    optional: bool = false,
};

pub const Collected = struct {
    files: []const []const u8,
    has_cpp: bool,
};

/// Walks `set` and returns its source files, sorted so that the resulting
/// command line — and therefore Zig's build cache key — is stable across
/// machines and filesystems.
pub fn collect(b: *std.Build, set: SourceSet) !Collected {
    const arena = b.allocator;

    if (set.files.len > 0) {
        var has_cpp = false;
        for (set.files) |f| {
            if (isCpp(f)) has_cpp = true;
        }
        return .{ .files = set.files, .has_cpp = has_cpp };
    }

    const dir_path = set.dir orelse return error.SourceSetNeedsDirOrFiles;

    var dir = b.build_root.handle.openDir(dir_path, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => {
            if (set.optional) return .{ .files = &.{}, .has_cpp = false };
            std.debug.panic(
                "zig-native-build: source directory '{s}' does not exist under {s}. " ++
                    "Create it, remove it from `sources`, or mark the set `.optional = true`.",
                .{ dir_path, b.build_root.path orelse "." },
            );
        },
        else => std.debug.panic("zig-native-build: cannot open '{s}': {s}", .{ dir_path, @errorName(err) }),
    };
    defer dir.close();

    var walker = try dir.walk(arena);
    defer walker.deinit();

    var files: std.ArrayList([]const u8) = .empty;
    var has_cpp = false;

    while (try walker.next()) |entry| {
        if (entry.kind != .file) continue;
        if (!hasExtension(entry.path, set.extensions)) continue;
        if (isExcluded(entry.path, set.exclude)) continue;
        // `walk` reuses its path buffer, so the name has to be copied out.
        const owned = try arena.dupe(u8, entry.path);
        // Zig wants forward slashes in source paths even on Windows.
        std.mem.replaceScalar(u8, owned, '\\', '/');
        try files.append(arena, owned);
        if (isCpp(owned)) has_cpp = true;
    }

    const slice = try files.toOwnedSlice(arena);
    std.mem.sort([]const u8, slice, {}, lessThan);
    return .{ .files = slice, .has_cpp = has_cpp };
}

fn lessThan(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

fn hasExtension(name: []const u8, extensions: []const []const u8) bool {
    for (extensions) |ext| {
        if (std.mem.endsWith(u8, name, ext)) return true;
    }
    return false;
}

fn isExcluded(name: []const u8, patterns: []const []const u8) bool {
    for (patterns) |pattern| {
        if (std.mem.indexOf(u8, name, pattern) != null) return true;
    }
    return false;
}

pub fn isCpp(name: []const u8) bool {
    return hasExtension(name, cpp_extensions);
}
