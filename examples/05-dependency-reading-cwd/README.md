# 05 — a dependency that reads the working directory

A build script is supposed to reach its own files through `b.path()` and
`b.build_root.handle`. Plenty of published packages reach for `std.fs.cwd()`
instead, and standalone the two are the same directory — so nothing says
otherwise until the day someone depends on the package.

`zig build` never changes directory, so a dependency's build script runs with
the *consumer's* project root as the working directory. A package that lists
its sources with `std.fs.cwd().openDir("src")` then walks the consumer's `src/`
— or, where the consumer has none, brings the whole build down before a single
file is compiled:

```
thread 12345 panic: unhandled error
    .NOENT => return error.FileNotFound,
…/some-package/build.zig:42: in addDirSources
    var dir = try std.fs.cwd().openDir(root, .{ .iterate = true });
```

Nothing in the message names the package that asked, and nothing a consumer
writes in its own `build.zig` reaches the dependency to fix it.

`linkDependency` — and `dependency`, and everything built on them — resolves a
package with the package's own directory current, so this works whichever way
the dependency spelled it.

```bash
npm run build
node --test
```

## What is in here

`vendor/tallies` is a small static library whose `build.zig` makes the mistake
on purpose, as a local path dependency so that nothing has to be fetched. Its
header comment says so at length; **do not copy that file.**

This project deliberately has **no `src/`**. That is what makes it a test: with
one, the dependency would have found *that* one and the build would have gone
through for the wrong reason. `test.mjs` asserts both halves of the fixture —
that there is still no `src/` here, and that the dependency still reads the
working directory — so that the day either is tidied up, the example says so
rather than quietly passing.

## Worth noticing

**The window is the resolution, not the build.** A build script declares steps
and nothing more; every step runs later, long after the directory has been put
back. Paths handed out in between are `LazyPath`s anchored to a package or
absolute, and neither is read at that point.

**A dependency of the dependency** is resolved with the dependency's directory
current rather than its own, because it goes through Zig's `b.dependency()`
rather than through the template's. Nearer than the consumer's root, and one
level is as far as guessing is worth taking.

**Fix it upstream where you can.** This is a courtesy, not a repair: the
package is still wrong, it still breaks for anyone building it another way, and
the one-word change is worth a pull request.
