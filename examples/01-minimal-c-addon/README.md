# 01 — a minimal C addon

The smallest thing worth building: two C functions, a Node-API binding, and a
`build.zig` that says nothing but the name.

```zig
const std = @import("std");
const czb = @import("c_cpp_zig_build");

pub fn build(b: *std.Build) !void {
    _ = try czb.addNodeAddon(b, .{ .name = "minimal_addon" });
}
```

Everything else follows from the layout: `src/` and `napi/` are compiled,
`include/` is on the header search path, libc is linked, the Node headers are
supplied by the build helper, and the result is installed as
`build/minimal_addon.node`.

```
include/mathx.h    the public interface — no Node.js in it
src/mathx.c        the implementation
napi/binding.c     the Node-API layer: converts values, calls into src/
index.cjs          loads build/minimal_addon.node
```

## Build and test

From this directory, with nothing installed:

```bash
bun run build      # or: npm run build
bun run test       # or: npm test
```

The scripts call `node ../../lib/cli.js`, so they use the checkout this
example lives in rather than a published release. In a project of your own the
same scripts read `c-cpp-zig-build`, after `npm install --save-dev
c-cpp-zig-build` — see [the examples README](../README.md#using-one-as-a-starting-point).

## Worth noticing

**`fib` returns a `BigInt`.** Fibonacci outgrows a double at n = 79, so the
result crosses as `napi_create_bigint_uint64` rather than silently losing
precision. Any 64-bit value — a hash, an id, a file offset — needs the same
treatment.

**The logic is not in `napi/`.** `mathx.c` knows nothing about Node, so it can
be linked into a test binary or a CLI, and read by someone who does not know
the Node-API. Example 3 takes that further.

**Cross compiling needs no changes:**

```bash
node ../../lib/cli.js build --target aarch64-macos --target x86_64-windows
```
