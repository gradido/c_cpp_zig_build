# Examples

Four complete, working projects. Each is buildable on its own and each teaches
one thing.

| | Example | Language | Shows |
|---|---|---|---|
| 1 | [`01-minimal-c-addon`](01-minimal-c-addon) | C | the smallest useful addon — a four-line `build.zig` |
| 2 | [`02-cpp-node-addon-api`](02-cpp-node-addon-api) | C++ | `node-addon-api`, automatic libc++, exceptions crossing into JS |
| 3 | [`03-library-cli-and-addon`](03-library-cli-and-addon) | C | one core behind an addon, a static library and a CLI; a `third_party/` file drop with its own flags |
| 4 | [`04-zig-package-dependency`](04-zig-package-dependency) | C | linking zstd as a Zig package — nothing vendored |

## Running them

From a clone of this repository:

```bash
node ../../lib/cli.js build      # from inside an example directory
node --test
```

Or all of them at once, from the repository root:

```bash
npm run test:examples
```

Example 2 declares its own `node-addon-api`, so run `npm install` there first
— it would build without it, using the copy that ships with the build tool,
but the point of the example is to pin the version.

Example 4 needs network access on its first build, to fetch zstd.

## Using one as a starting point

Copy the directory, then:

1. Change `name` in `package.json`.
2. Change `.name` in `build.zig` and `build.zig.zon`, and the file name in
   `index.cjs` to match.
3. Regenerate the fingerprint in `build.zig.zon`: delete the line, build once,
   and paste the value Zig prints.

Or skip all of that and run `c-cpp-zig-build init` in an empty directory.
