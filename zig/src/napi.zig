//! The Windows half of building a Node-API addon.
//!
//! On Linux and macOS the `napi_*` symbols stay undefined in the addon and are
//! resolved by the process that loads it. Windows does not allow a DLL with
//! undefined symbols, so the addon must be linked against an import library
//! for the host executable.
//!
//! One is built here, from the module definition file that `node-api-headers`
//! ships, using `zig dlltool`. It needs no download, and unlike a `node.lib`
//! from nodejs.org it works for Bun too: the same `.def` produces an import
//! library against `bun.exe` as readily as against `node.exe`, which is what
//! lets a single build serve both runtimes.

const std = @import("std");

pub fn dlltoolMachine(target: std.Build.ResolvedTarget) []const u8 {
    return switch (target.result.cpu.arch) {
        .x86_64 => "i386:x86-64",
        .x86 => "i386",
        .aarch64 => "arm64",
        else => std.debug.panic(
            "c-cpp-zig-build: no dlltool machine name for Windows on {s}",
            .{@tagName(target.result.cpu.arch)},
        ),
    };
}

/// Builds an import library that resolves the Node-API exports of
/// `host_executable` (`node.exe` or `bun.exe`) from a module definition file.
pub fn importLibraryFromDef(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    def_path: []const u8,
    host_executable: []const u8,
) std.Build.LazyPath {
    const dlltool = b.addSystemCommand(&.{ b.graph.zig_exe, "dlltool" });
    dlltool.addArgs(&.{ "-m", dlltoolMachine(target), "-D", host_executable });
    dlltool.addArg("-d");
    dlltool.addFileArg(.{ .cwd_relative = def_path });
    dlltool.addArg("-l");
    return dlltool.addOutputFileArg(b.fmt("{s}_api.lib", .{std.fs.path.stem(host_executable)}));
}
