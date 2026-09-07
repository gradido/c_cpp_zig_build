# Examples

Six complete, working projects. Each is buildable on its own and each teaches
one thing.

| | Example | Language | Shows |
|---|---|---|---|
| 1 | [`01-minimal-c-addon`](01-minimal-c-addon) | C | the smallest useful addon — a four-line `build.zig` |
| 2 | [`02-cpp-node-addon-api`](02-cpp-node-addon-api) | C++ | `node-addon-api`, automatic libc++, exceptions crossing into JS |
| 3 | [`03-library-cli-and-addon`](03-library-cli-and-addon) | C | one core behind an addon, a static library and a CLI; a `third_party/` file drop with its own flags |
| 4 | [`04-zig-package-dependency`](04-zig-package-dependency) | C | linking zstd as a Zig package — nothing vendored |
| 5 | [`05-dependency-reading-cwd`](05-dependency-reading-cwd) | C | a dependency whose `build.zig` reads the working directory, and why it still builds |
| 6 | [`06-turborepo`](06-turborepo) | C | a turborepo workspace — declaring the addon as a task `output`, and what a cache hit does without it |

## Running them

Every example is runnable straight from a clone, with nothing installed:

```bash
cd examples/01-minimal-c-addon
bun run build       # or: npm run build
bun run test        # or: npm test
```

Each also has `bun run build:debug`, `bun run info` (what the build would use)
and `bun run clean` (undo everything a build wrote).

**With Bun, keep the `run`.** `build`, `test` and `info` are all Bun
sub-commands of their own, and a bare `bun <name>` runs Bun's rather than the
script — `bun info` asks the npm registry about a package that was never
published (`404 Not Found: …/minimal-addon-example`), and `bun test` looks for
its own test files and finds none. `bun run info` and `bun run test` do what
you meant. npm has no such collision: `npm test` and `npm run test` are the
same thing.

Their scripts call `node ../../lib/cli.js` rather than the `c-cpp-zig-build`
command, on purpose: that is the copy of the build tool sitting two directories
up, so an example always exercises this checkout and never a release from npm.
Nothing has to be linked or installed for that to work. What you would write in
a project of your own is below.

Or all of them at once, from the repository root:

```bash
npm run test:examples
```

Two of them install something first. Example 2 declares its own
`node-addon-api` — it would build without it, using the copy that ships with
the build tool, but the point of the example is to pin the version. Example 6
needs `turbo` itself. In both, run `bun install` (or `npm install`) in that
directory before the first build.

Example 4 needs network access on its first build, to fetch zstd. Example 5
fetches nothing: its dependency is a local path.

Example 6 is a workspace rather than a single project, so its `build` and
`test` scripts run `turbo` instead of the build tool directly; the addon it
contains is built the same way as every other example, two directories deeper.
It also has `bun run clear`, which resets it — turbo's cache included — so the
first build can be watched more than once.

The first build of any of them downloads the Zig toolchain into `~/.zig-build`,
which takes a minute; every build after that is fast.

## Using one as a starting point

Copy the directory, then:

1. Change `name` in `package.json`.
2. Depend on the real package instead of the checkout:

   ```bash
   npm install --save-dev c-cpp-zig-build     # or: bun add -d c-cpp-zig-build
   ```

   and replace `node ../../lib/cli.js` in every script with
   `c-cpp-zig-build`, which `npm run` / `bun run` then finds on the PATH:

   ```json
   "scripts": {
     "build": "c-cpp-zig-build build",
     "test": "node --test"
   }
   ```

3. Change `.name` in `build.zig` and `build.zig.zon`, and the file name in
   `index.cjs` to match.
4. Regenerate the fingerprint in `build.zig.zon`: delete the line, build once,
   and paste the value Zig prints.

Or skip all of that and run `c-cpp-zig-build init` in an empty directory.
