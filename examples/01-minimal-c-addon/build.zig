const std = @import("std");
const czb = @import("c_cpp_zig_build");

pub fn build(b: *std.Build) !void {
    // Everything else follows from the layout: src/ and napi/ are compiled,
    // include/ is on the header search path, and the result is installed as
    // minimal_addon.node.
    _ = try czb.addNodeAddon(b, .{ .name = "minimal_addon" });
}
