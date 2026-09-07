const std = @import("std");
const czb = @import("c_cpp_zig_build");

pub fn build(b: *std.Build) !void {
    // Nothing here knows about turbo. The layout decides the rest: src/ and
    // napi/ are compiled, include/ is on the header search path, and the
    // result is installed as build/crc32_addon.node — which is exactly the
    // path turbo.json declares as this task's output.
    _ = try czb.addNodeAddon(b, .{ .name = "crc32_addon" });
}
