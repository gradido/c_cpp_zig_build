const std = @import("std");
const czb = @import("c_cpp_zig_build");

pub fn build(b: *std.Build) !void {
    // libc++ is linked automatically because C++ sources are present, and the
    // node-addon-api headers are added automatically because the package is
    // installed. Only the C++ standard is worth naming here.
    _ = try czb.addNodeAddon(b, .{
        .name = "matrix_addon",
        .cpp_std = "c++20",
    });
}
