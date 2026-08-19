//! Emits a `compile_commands.json` next to `build.zig`.
//!
//! clangd, ccls and every C/C++ IDE integration read this file to learn how a
//! translation unit is compiled. Zig knows all of it already; this step walks
//! the artifacts that were registered and writes the database out.
//!
//! It is written here rather than pulled in as a Zig package so that the
//! template has no dependencies of its own: a project's `build.zig.zon` stays
//! free for the project's own libraries.

const std = @import("std");

const Compile = std.Build.Step.Compile;

/// Registered artifacts, filled in as the build script runs and read once, at
/// make time, when the list is complete. Holding a pointer to the list rather
/// than a snapshot of it is what lets `addNodeAddon` and `addLibrary` be
/// called in any order without the caller having to finalise anything.
pub const Generator = struct {
    b: *std.Build,
    step: std.Build.Step,
    artifacts: std.ArrayList(*Compile),
    out_path: []const u8,

    pub fn create(b: *std.Build, out_path: []const u8) *Generator {
        const self = b.allocator.create(Generator) catch @panic("OOM");
        self.* = .{
            .b = b,
            .step = std.Build.Step.init(.{
                .id = .custom,
                .name = "compile_commands.json",
                .owner = b,
                .makeFn = make,
            }),
            .artifacts = .empty,
            .out_path = out_path,
        };
        return self;
    }

    pub fn add(self: *Generator, artifact: *Compile) void {
        self.artifacts.append(self.b.allocator, artifact) catch @panic("OOM");
        // The database describes how sources are compiled, so it must not be
        // written before the artifacts that describe them exist.
        self.step.dependOn(&artifact.step);
    }
};

fn make(step: *std.Build.Step, options: std.Build.Step.MakeOptions) anyerror!void {
    _ = options;
    const self: *Generator = @fieldParentPtr("step", step);
    const b = self.b;
    const arena = b.allocator;

    var out: std.ArrayList(u8) = .empty;
    const w = &out;

    try w.appendSlice(arena, "[\n");
    var first = true;

    const directory = b.build_root.path orelse ".";

    for (self.artifacts.items) |artifact| {
        const module = artifact.root_module;

        // Flags shared by every translation unit of this artifact: include
        // paths, macros, and the target triple clangd needs to pick the right
        // builtin definitions.
        var common: std.ArrayList([]const u8) = .empty;
        // A plain arch-os-abi triple, not Zig's version-ranged one: clang and
        // clangd understand the former and reject the latter.
        const t = artifact.rootModuleTarget();
        try common.append(arena, "-target");
        try common.append(arena, try std.Target.linuxTripleSimple(arena, t.cpu.arch, t.os.tag, t.abi));

        for (module.include_dirs.items) |include_dir| {
            switch (include_dir) {
                .path => |lp| {
                    try common.append(arena, "-I");
                    try common.append(arena, lp.getPath2(b, step));
                },
                .path_system => |lp| {
                    try common.append(arena, "-isystem");
                    try common.append(arena, lp.getPath2(b, step));
                },
                .path_after => |lp| {
                    try common.append(arena, "-idirafter");
                    try common.append(arena, lp.getPath2(b, step));
                },
                .framework_path => |lp| {
                    try common.append(arena, "-F");
                    try common.append(arena, lp.getPath2(b, step));
                },
                .framework_path_system => |lp| {
                    try common.append(arena, "-iframework");
                    try common.append(arena, lp.getPath2(b, step));
                },
                .other_step => |other| {
                    if (other.installed_headers_include_tree) |tree| {
                        try common.append(arena, "-I");
                        try common.append(arena, tree.getDirectory().getPath2(b, step));
                    }
                },
                .config_header_step => |ch| {
                    try common.append(arena, "-I");
                    try common.append(arena, ch.getOutputDir().getPath2(b, step));
                },
                .embed_path => {},
            }
        }

        // `c_macros` are already stored in `-DNAME=value` form.
        for (module.c_macros.items) |macro| try common.append(arena, macro);

        for (module.link_objects.items) |link_object| switch (link_object) {
            .c_source_file => |csf| {
                const file = csf.file.getPath2(b, step);
                try writeEntry(arena, w, &first, directory, file, common.items, csf.flags);
            },
            .c_source_files => |csfs| {
                const root = csfs.root.getPath2(b, step);
                for (csfs.files) |rel| {
                    const file = try std.fs.path.join(arena, &.{ root, rel });
                    try writeEntry(arena, w, &first, directory, file, common.items, csfs.flags);
                }
            },
            else => {},
        };
    }

    try w.appendSlice(arena, "\n]\n");

    // Only rewrite when the content changed: clangd re-indexes the whole
    // project whenever this file's mtime moves.
    const previous = b.build_root.handle.readFileAlloc(arena, self.out_path, 64 * 1024 * 1024) catch null;
    if (previous == null or !std.mem.eql(u8, previous.?, out.items)) {
        try b.build_root.handle.writeFile(.{ .sub_path = self.out_path, .data = out.items });
    }
}

fn writeEntry(
    arena: std.mem.Allocator,
    w: *std.ArrayList(u8),
    first: *bool,
    directory: []const u8,
    file: []const u8,
    common: []const []const u8,
    flags: []const []const u8,
) !void {
    if (!first.*) try w.appendSlice(arena, ",\n");
    first.* = false;

    try w.appendSlice(arena, "  {\n    \"directory\": ");
    try writeJsonString(arena, w, directory);
    try w.appendSlice(arena, ",\n    \"file\": ");
    try writeJsonString(arena, w, file);
    try w.appendSlice(arena, ",\n    \"arguments\": [");

    // clangd wants argv[0] to look like a compiler driver.
    try writeJsonString(arena, w, "cc");
    for (common) |flag| {
        try w.appendSlice(arena, ", ");
        try writeJsonString(arena, w, flag);
    }
    for (flags) |flag| {
        try w.appendSlice(arena, ", ");
        try writeJsonString(arena, w, flag);
    }
    try w.appendSlice(arena, ", ");
    try writeJsonString(arena, w, "-c");
    try w.appendSlice(arena, ", ");
    try writeJsonString(arena, w, file);
    try w.appendSlice(arena, "]\n  }");
}

fn writeJsonString(arena: std.mem.Allocator, w: *std.ArrayList(u8), value: []const u8) !void {
    try w.append(arena, '"');
    for (value) |ch| switch (ch) {
        '"' => try w.appendSlice(arena, "\\\""),
        '\\' => try w.appendSlice(arena, "\\\\"),
        '\n' => try w.appendSlice(arena, "\\n"),
        '\r' => try w.appendSlice(arena, "\\r"),
        '\t' => try w.appendSlice(arena, "\\t"),
        else => try w.append(arena, ch),
    };
    try w.append(arena, '"');
}
