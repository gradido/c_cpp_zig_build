const std = @import("std");
const czb = @import("c_cpp_zig_build");

pub fn build(b: *std.Build) !void {
    // No src/ here: everything this addon does comes from the package below.
    // That is what makes this a test — a dependency that looks for its own
    // sources in the working directory would look for them in *this*
    // directory, and there is nothing here to find.
    const addon = try czb.addNodeAddon(b, .{
        .name = "tally_addon",
        .sources = &.{.{ .dir = "napi" }},
    });

    // vendor/tallies lists its sources through std.fs.cwd(), which is the
    // mistake this example exists for; see the note at the top of its
    // build.zig. linkDependency resolves it with its own directory current, so
    // it finds what it is looking for and the build goes through.
    addon.linkDependency("tallies", "tallies");
}
