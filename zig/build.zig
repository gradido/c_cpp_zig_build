//! c-cpp-zig-build — a build.zig template for native Node.js modules.
//!
//! A project describes itself with a name and, if it needs to, a handful of
//! overrides; everything else follows from the directory layout:
//!
//!     const std = @import("std");
//!     const czb = @import("c_cpp_zig_build");
//!
//!     pub fn build(b: *std.Build) !void {
//!         _ = try czb.addNodeAddon(b, .{ .name = "my_native" });
//!     }
//!
//! That compiles every C/C++ file under `src/` and `napi/`, adds `include/`
//! and `third_party/` to the header search path, links libc (and libc++ when
//! any C++ source is present), points the compiler at the Node headers the
//! build helper downloaded, and installs `my_native.node` into the output
//! directory. Anything beyond that is done on the returned artifact, which is
//! an ordinary `std.Build.Step.Compile` with a few conveniences attached.
//!
//! This file is copied into a project as `.zig-native/` by the `c-cpp-zig-build`
//! npm package. It is generated — edit the package, not the copy.

const std = @import("std");

const cdb = @import("src/compile_commands.zig");
const napi = @import("src/napi.zig");
const sources = @import("src/sources.zig");

pub const SourceSet = sources.SourceSet;

/// A preprocessor definition. `value` defaults to `1`, which is what a bare
/// `-DFOO` means to a C compiler.
pub const Define = struct {
    name: []const u8,
    value: []const u8 = "1",
};

/// What to build. Chosen by which function you call, not by an option.
pub const Kind = enum { node_addon, static_library, shared_library, executable };

pub const Options = struct {
    /// Artifact name. For a Node addon this is also the file name, so
    /// `.name = "my_native"` produces `my_native.node`.
    name: []const u8,

    /// Where the sources are. Directories are walked recursively; every
    /// `.c`, `.cpp`, `.cc`, `.cxx`, `.m`, `.mm` and `.S` file found is
    /// compiled. Drop a file in, and the next build picks it up.
    ///
    /// Defaults to `src/` plus, for Node addons, an optional `napi/`.
    sources: ?[]const SourceSet = null,

    /// Header search paths, relative to the project root. Entries that do not
    /// exist are skipped, so `third_party/` can be created later — or never.
    include: []const []const u8 = &.{ "include", "third_party" },

    /// Flags for every translation unit.
    flags: []const []const u8 = &.{},
    /// Flags added on top of `flags` for C sources only.
    c_flags: []const []const u8 = &.{},
    /// Flags added on top of `flags` for C++ sources only.
    cpp_flags: []const []const u8 = &.{},

    /// `-std=` for C and C++ respectively. Left to the compiler's default
    /// when null.
    c_std: ?[]const u8 = null,
    cpp_std: ?[]const u8 = null,

    /// `-Wall -Wextra`, which is what you want and what nobody remembers to
    /// type. Set `.warnings = false` on an individual source set to spare a
    /// vendored library from them.
    warnings: bool = true,
    /// Adds `-Wpedantic`. Off by default, and deliberately: clang promotes
    /// several pedantic findings to errors, and real third-party C — CRoaring
    /// and every other SIMD-heavy library among it — does not survive it.
    pedantic: bool = false,
    /// Turn warnings into errors. Off by default: a third-party library you
    /// merely dropped into `third_party/` should not be able to fail a build.
    warnings_as_errors: bool = false,

    /// Preprocessor definitions applied to the whole artifact.
    defines: []const Define = &.{},

    link_libc: bool = true,
    /// Link libc++. Null means "when any C++ source was found", which is
    /// almost always the right answer.
    link_libcpp: ?bool = null,

    /// Overrides for the target and optimisation mode. Both default to the
    /// values the build helper passes on the command line.
    target: ?std.Build.ResolvedTarget = null,
    optimize: ?std.builtin.OptimizeMode = null,

    /// Output file name. Defaults to `<name>.node` for addons and to Zig's
    /// platform-specific naming for everything else.
    out_name: ?[]const u8 = null,

    /// Install straight into the output directory instead of the `bin/` and
    /// `lib/` subdirectories Zig uses by default. Node addons always do this;
    /// libraries and executables do it only when asked.
    flat: bool = false,

    /// Contribute this artifact to `compile_commands.json`.
    compile_commands: bool = true,

    /// C++ exception support. Turning it off also defines the two macros that
    /// switch `node-addon-api` over to its no-exception error handling.
    exceptions: bool = true,

    /// Also build a Bun-specific addon on Windows, where Bun exports the
    /// Node-API from `bun.exe` rather than `node.exe`. Ignored elsewhere,
    /// where one addon serves both runtimes.
    ///
    /// Null means "whenever the build helper says Bun is installed".
    bun: ?bool = null,
};

/// The result of adding an artifact: a thin wrapper over the underlying
/// `Compile` step, so that anything the template does not cover is still one
/// method call away.
pub const Artifact = struct {
    b: *std.Build,
    /// The primary compile step. On Windows a Node addon may have a second
    /// one for Bun; the helpers below apply to both, this field is the first.
    compile: *std.Build.Step.Compile,
    /// Every compile step this artifact produced, Bun variant included.
    compiles: []const *std.Build.Step.Compile,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    /// The options this artifact was created with, so that sources added
    /// later are compiled the same way as the ones added up front.
    options: Options,

    /// Resolves a `build.zig.zon` dependency with this artifact's target and
    /// optimisation mode, plus any options the package itself declares.
    ///
    ///     const sodium = addon.dependency("libsodium", .{ .static = true, .shared = false });
    ///     addon.compile.linkLibrary(sodium.artifact("libsodium-static"));
    ///
    /// Pass `.{}` when the package takes no options. Do not pass `target` or
    /// `optimize`; they are supplied.
    pub fn dependency(self: Artifact, dep_name: []const u8, extra: anytype) *std.Build.Dependency {
        const extra_fields = @typeInfo(@TypeOf(extra)).@"struct".fields;

        const Merged = comptime blk: {
            var fields: []const std.builtin.Type.StructField = &.{
                .{
                    .name = "target",
                    .type = std.Build.ResolvedTarget,
                    .default_value_ptr = null,
                    .is_comptime = false,
                    .alignment = @alignOf(std.Build.ResolvedTarget),
                },
                .{
                    .name = "optimize",
                    .type = std.builtin.OptimizeMode,
                    .default_value_ptr = null,
                    .is_comptime = false,
                    .alignment = @alignOf(std.builtin.OptimizeMode),
                },
            };
            for (extra_fields) |field| fields = fields ++ [_]std.builtin.Type.StructField{field};
            break :blk @Type(.{ .@"struct" = .{
                .layout = .auto,
                .fields = fields,
                .decls = &.{},
                .is_tuple = false,
            } });
        };

        var merged: Merged = undefined;
        merged.target = self.target;
        merged.optimize = self.optimize;
        inline for (extra_fields) |field| {
            @field(merged, field.name) = @field(extra, field.name);
        }
        return resolveDependency(self.b, dep_name, merged);
    }

    /// Links a library from a `build.zig.zon` dependency.
    ///
    ///     const addon = try czb.addNodeAddon(b, .{ .name = "my_native" });
    ///     addon.linkDependency("zstd", "zstd");
    ///
    /// The dependency is resolved with the same target and optimisation mode
    /// as the artifact, which is what you want and easy to get wrong by hand.
    /// When the package needs options of its own, use `linkDependencyWith`.
    pub fn linkDependency(self: Artifact, dep_name: []const u8, artifact_name: []const u8) void {
        self.linkDependencyWith(dep_name, artifact_name, .{});
    }

    /// `linkDependency` for a package that takes build options — a choice
    /// between a static and a shared build, say, or a feature flag.
    ///
    ///     addon.linkDependencyWith("libsodium", "libsodium-static", .{
    ///         .static = true,
    ///         .shared = false,
    ///     });
    pub fn linkDependencyWith(
        self: Artifact,
        dep_name: []const u8,
        artifact_name: []const u8,
        extra: anytype,
    ) void {
        const dep = self.dependency(dep_name, extra);
        for (self.compiles) |compile| compile.linkLibrary(dep.artifact(artifact_name));
    }

    /// Adds a dependency's headers without linking anything — for the common
    /// case of a header-only library, or of using another package's public
    /// headers while providing the implementation yourself.
    pub fn addDependencyIncludePath(self: Artifact, dep_name: []const u8, sub_path: []const u8) void {
        for (self.compiles) |compile| {
            compile.addIncludePath(self.dependency(dep_name, .{}).path(sub_path));
        }
    }

    /// Adds a header search path relative to the project root.
    pub fn addIncludePath(self: Artifact, rel_path: []const u8) void {
        for (self.compiles) |compile| compile.addIncludePath(self.b.path(rel_path));
    }

    /// Adds a preprocessor definition.
    pub fn addDefine(self: Artifact, name: []const u8, value: []const u8) void {
        for (self.compiles) |compile| compile.root_module.addCMacro(name, value);
    }

    /// Compiles an extra group of sources into this artifact — the escape
    /// hatch for a vendored library that needs its own flags.
    ///
    ///     addon.addSources(.{
    ///         .dir = "third_party/CRoaring",
    ///         .files = &.{"roaring.c"},
    ///         .flags = &.{"-DCROARING_COMPILER_SUPPORTS_AVX512=0"},
    ///     });
    pub fn addSources(self: Artifact, set: SourceSet) void {
        for (self.compiles) |compile| {
            attachSources(self.b, compile, set, self.options) catch |err| {
                std.debug.panic("c-cpp-zig-build: {s}", .{@errorName(err)});
            };
        }
    }

    /// Links a system library by name (`-lm`, `-lpthread`, ...).
    pub fn linkSystemLibrary(self: Artifact, name: []const u8) void {
        for (self.compiles) |compile| compile.linkSystemLibrary(name);
    }
};

// ---------------------------------------------------------------------------
//  Public entry points
// ---------------------------------------------------------------------------

/// Present so that this package can appear in a project's `build.zig.zon`.
///
/// `b.dependency()` compiles a code path for every declared dependency, and
/// each of those paths needs a `build` function to exist — so a project that
/// declares this template and then fetches any other package would otherwise
/// fail to compile its build script. Nothing calls this.
pub fn build(b: *std.Build) void {
    _ = b;
}

/// Builds a Node-API addon: a shared library installed as `<name>.node`.
pub fn addNodeAddon(b: *std.Build, options: Options) !Artifact {
    return add(b, .node_addon, options);
}

/// Builds a static library. Useful for the "one core library, several
/// consumers" layout, where the addon and a command line tool share code.
pub fn addStaticLibrary(b: *std.Build, options: Options) !Artifact {
    return add(b, .static_library, options);
}

/// Builds a shared library (`.so` / `.dylib` / `.dll`).
pub fn addSharedLibrary(b: *std.Build, options: Options) !Artifact {
    return add(b, .shared_library, options);
}

/// Builds an executable — a test runner, a benchmark, an index builder.
pub fn addExecutable(b: *std.Build, options: Options) !Artifact {
    return add(b, .executable, options);
}

/// The target and optimisation mode the build helper selected, for build
/// scripts that need them before adding anything.
pub fn standardOptions(b: *std.Build) struct {
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
} {
    const ctx = context(b);
    return .{ .target = ctx.target, .optimize = ctx.optimize };
}

/// `b.dependency()`, with the package's own directory as the working directory
/// while its build script runs.
///
/// Use this in place of `b.dependency()` for a package resolved by hand;
/// `Artifact.dependency()` and everything built on it already go through here.
///
/// ### Why a build script needs this
///
/// A build script is supposed to reach its own files through `b.path()` and
/// `b.build_root.handle`, both of which are anchored to the package. Plenty
/// reach for `std.fs.cwd()` instead, and standalone the two are the same
/// directory, so nothing says otherwise until the day someone depends on the
/// package: `zig build` never changes directory, so the working directory
/// throughout is the *consumer's* project root. A package that lists its own
/// sources with `std.fs.cwd().openDir("src")` then walks the consumer's `src/`
/// — or, where the consumer has none, panics with `FileNotFound` before a
/// single file is compiled, whatever the consumer actually wanted from it.
///
/// Nothing a consumer can do about that reaches the dependency, and the failure
/// names a directory in the wrong project, which is a hard afternoon. So the
/// directory is put where such a package assumes it is, for as long as its
/// build script runs, and put back afterwards.
///
/// The window is the `b.dependency()` call itself: build scripts declare steps
/// and nothing more, and every step runs later, long after this has returned.
/// Paths handed out in between are `LazyPath`s anchored to a package or
/// absolute, and neither is read now.
///
/// A dependency of the dependency is resolved with the *dependency's*
/// directory current rather than its own, since it goes through Zig's
/// `b.dependency()` rather than through this. Still nearer than the consumer's
/// root, and one level is as far as guessing is worth taking.
pub fn dependency(b: *std.Build, dep_name: []const u8, args: anytype) *std.Build.Dependency {
    return resolveDependency(b, dep_name, args);
}

/// The implementation of both `dependency()` and `Artifact.dependency()`, named
/// apart from either: inside `Artifact` the method shadows the free function,
/// and Zig calls a reference to the two of them ambiguous rather than guessing.
fn resolveDependency(b: *std.Build, dep_name: []const u8, args: anytype) *std.Build.Dependency {
    const previous = enterPackageDirectory(b, dep_name);
    defer leavePackageDirectory(b, previous);
    return b.dependency(dep_name, args);
}

/// Makes @p dep_name's directory current, and answers the one that was, or
/// null when nothing was changed and nothing has to be put back.
///
/// Every failure here answers null: this is a courtesy to badly behaved
/// dependencies, and a package that does not need it must not be denied a
/// build because the courtesy could not be extended.
fn enterPackageDirectory(b: *std.Build, dep_name: []const u8) ?[]const u8 {
    const build_root = packageBuildRoot(b, dep_name) orelse return null;

    // Read rather than taken from `b.build_root`, which may be relative — and a
    // relative path is no way back once the directory has moved.
    const previous = std.process.getCwdAlloc(b.allocator) catch return null;
    std.process.changeCurDir(build_root) catch {
        b.allocator.free(previous);
        return null;
    };
    return previous;
}

fn leavePackageDirectory(b: *std.Build, previous: ?[]const u8) void {
    const path = previous orelse return;
    // Loud, and rightly so: everything after this would run somewhere the rest
    // of the build has no idea about.
    std.process.changeCurDir(path) catch |err| std.debug.panic(
        "c-cpp-zig-build: cannot return to '{s}' after resolving a dependency: {s}",
        .{ path, @errorName(err) },
    );
    b.allocator.free(path);
}

/// Where a declared dependency was fetched to, or null when it cannot be said —
/// an undeclared name, or a lazy package nobody has fetched yet. Both are left
/// for `b.dependency()` to report in its own words.
fn packageBuildRoot(b: *std.Build, dep_name: []const u8) ?[]const u8 {
    const build_runner = @import("root");
    const deps = build_runner.dependencies;

    const pkg_hash = for (b.available_deps) |dep| {
        if (std.mem.eql(u8, dep[0], dep_name)) break dep[1];
    } else return null;

    inline for (@typeInfo(deps.packages).@"struct".decls) |decl| {
        if (std.mem.eql(u8, decl.name, pkg_hash)) {
            const pkg = @field(deps.packages, decl.name);
            // `available` marks a lazy package; an unfetched one has no
            // directory to enter.
            if (@hasDecl(pkg, "available") or !@hasDecl(pkg, "build_root")) return null;
            return pkg.build_root;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
//  Shared per-build state
// ---------------------------------------------------------------------------

const Context = struct {
    next: ?*Context = null,
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,

    node_headers: ?[]const u8,
    napi_headers: ?[]const u8,
    node_lib: ?[]const u8,
    node_api_def: ?[]const u8,
    napi_version: []const u8,
    bun: bool,
    rpath: ?[]const u8,

    cdb: ?*cdb.Generator,
};

/// Contexts are keyed by builder rather than kept in one global, so that a
/// project and a dependency that both use this template do not overwrite each
/// other's options.
var context_list: ?*Context = null;

fn context(b: *std.Build) *Context {
    var it = context_list;
    while (it) |ctx| : (it = ctx.next) {
        if (ctx.b == b) return ctx;
    }

    // Naming the ABI keeps the host's architecture while making Zig use its
    // own libc headers. A bare "native" target reaches into /usr/include and
    // drags in whatever kernel headers happen to be installed; -Dtarget still
    // overrides this for cross builds.
    const target = b.standardTargetOptions(.{ .default_target = .{ .abi = defaultAbi() } });
    // Plain `standardOptimizeOption`, so that `-Doptimize=...` stays available:
    // naming a preferred mode here would replace it with `--release`, and the
    // build helper passes the mode explicitly. A bare `zig build` is a debug
    // build, as everywhere else in Zig.
    const optimize = b.standardOptimizeOption(.{});

    const ctx = b.allocator.create(Context) catch @panic("OOM");
    ctx.* = .{
        .next = context_list,
        .b = b,
        .target = target,
        .optimize = optimize,
        .node_headers = b.option([]const u8, "node-headers", "Directory containing node_api.h"),
        .napi_headers = b.option([]const u8, "napi-headers", "Directory containing napi.h (node-addon-api)"),
        .node_lib = b.option([]const u8, "node-lib", "Windows import library for the host executable"),
        .node_api_def = b.option([]const u8, "node-api-def", "Windows module definition file for the Node-API exports"),
        .napi_version = b.option([]const u8, "napi-version", "Node-API version to target") orelse "8",
        .bun = b.option(bool, "bun", "Also build a Bun addon on Windows") orelse false,
        .rpath = b.option([]const u8, "rpath", "Runtime library search path"),
        .cdb = null,
    };
    context_list = ctx;
    return ctx;
}

fn defaultAbi() std.Target.Abi {
    return switch (@import("builtin").target.os.tag) {
        .linux => .gnu,
        else => @import("builtin").target.abi,
    };
}

fn compileCommands(ctx: *Context) *cdb.Generator {
    if (ctx.cdb) |generator| return generator;
    const generator = cdb.Generator.create(ctx.b, "compile_commands.json");
    const step = ctx.b.step("cdb", "Write compile_commands.json for clangd and friends");
    step.dependOn(&generator.step);
    // Every build refreshes it; an IDE should never see a stale database.
    ctx.b.getInstallStep().dependOn(&generator.step);
    ctx.cdb = generator;
    return generator;
}

// ---------------------------------------------------------------------------
//  Implementation
// ---------------------------------------------------------------------------

fn add(b: *std.Build, kind: Kind, options: Options) !Artifact {
    const ctx = context(b);
    const target = options.target orelse ctx.target;
    const optimize = options.optimize orelse ctx.optimize;

    const source_sets = options.sources orelse defaultSources(kind);

    // Whether libc++ is needed is decided by what is actually there, so a
    // project that adds its first .cpp file does not also have to remember to
    // flip a switch.
    var has_cpp = false;
    for (source_sets) |set| {
        const collected = try sources.collect(b, set);
        if (collected.has_cpp) has_cpp = true;
    }

    var compiles: std.ArrayList(*std.Build.Step.Compile) = .empty;

    const wants_bun_variant = kind == .node_addon and
        target.result.os.tag == .windows and
        (options.bun orelse ctx.bun);

    const primary = makeCompile(b, kind, target, optimize, options.name);
    try compiles.append(b.allocator, primary);

    var bun_compile: ?*std.Build.Step.Compile = null;
    if (wants_bun_variant) {
        bun_compile = makeCompile(b, kind, target, optimize, b.fmt("{s}-bun", .{options.name}));
        try compiles.append(b.allocator, bun_compile.?);
    }

    for (compiles.items) |compile| {
        try configure(b, ctx, compile, kind, options, target, has_cpp, source_sets);
    }

    // Windows needs an import library; which one depends on the runtime.
    if (kind == .node_addon and target.result.os.tag == .windows) {
        try linkWindowsHost(b, ctx, primary, target, "node.exe");
        if (bun_compile) |compile| try linkWindowsHost(b, ctx, compile, target, "bun.exe");
    }

    install(b, primary, kind, options, options.out_name);
    if (bun_compile) |compile| {
        install(b, compile, kind, options, b.fmt("{s}.bun.node", .{options.name}));
    }

    if (options.compile_commands) {
        // Only the primary artifact is indexed: the Bun variant compiles the
        // same sources, and a duplicate entry per file confuses clangd.
        compileCommands(ctx).add(primary);
    }

    return .{
        .b = b,
        .compile = primary,
        .compiles = try compiles.toOwnedSlice(b.allocator),
        .target = target,
        .optimize = optimize,
        .options = options,
    };
}

fn defaultSources(kind: Kind) []const SourceSet {
    return switch (kind) {
        // `napi/` is where the bindings live by convention, but a project that
        // keeps them in `src/` is not doing anything wrong.
        .node_addon => &.{ .{ .dir = "src", .optional = true }, .{ .dir = "napi", .optional = true } },
        else => &.{.{ .dir = "src" }},
    };
}

fn makeCompile(
    b: *std.Build,
    kind: Kind,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    name: []const u8,
) *std.Build.Step.Compile {
    const module = b.createModule(.{ .target = target, .optimize = optimize });
    return switch (kind) {
        .node_addon, .shared_library => b.addLibrary(.{
            .name = name,
            .linkage = .dynamic,
            .root_module = module,
        }),
        .static_library => b.addLibrary(.{
            .name = name,
            .linkage = .static,
            .root_module = module,
        }),
        .executable => b.addExecutable(.{ .name = name, .root_module = module }),
    };
}

fn configure(
    b: *std.Build,
    ctx: *Context,
    compile: *std.Build.Step.Compile,
    kind: Kind,
    options: Options,
    target: std.Build.ResolvedTarget,
    has_cpp: bool,
    source_sets: []const SourceSet,
) !void {
    if (options.link_libc) compile.linkLibC();
    if (options.link_libcpp orelse has_cpp) compile.linkLibCpp();

    for (options.include) |dir| {
        // A missing include directory is not an error: `third_party/` is
        // created when a project first vendors something, and until then the
        // default should not have to be edited away.
        if (dirExists(b, dir)) compile.addIncludePath(b.path(dir));
    }

    for (options.defines) |define| compile.root_module.addCMacro(define.name, define.value);

    if (!options.exceptions) {
        compile.root_module.addCMacro("NAPI_DISABLE_CPP_EXCEPTIONS", "1");
        compile.root_module.addCMacro("NODE_ADDON_API_ENABLE_MAYBE", "1");
    }

    if (kind == .node_addon) {
        compile.root_module.addCMacro("NAPI_VERSION", ctx.napi_version);
        compile.root_module.addCMacro("BUILDING_NODE_EXTENSION", "1");

        // The Node headers come from outside the project, so they are added as
        // system headers: warnings in someone else's headers are noise.
        if (ctx.node_headers) |dir| {
            compile.root_module.addSystemIncludePath(.{ .cwd_relative = dir });
        } else {
            std.debug.panic(
                "c-cpp-zig-build: no Node headers were provided. Build through the " ++
                    "`c-cpp-zig-build` command, or pass -Dnode-headers=<dir> yourself.",
                .{},
            );
        }
        if (ctx.napi_headers) |dir| {
            compile.root_module.addSystemIncludePath(.{ .cwd_relative = dir });
        }

        // macOS refuses to link a shared library with undefined symbols unless
        // told that they will be there at load time. They will be: the Node
        // process that dlopens the addon exports them.
        if (target.result.os.tag == .macos) compile.linker_allow_shlib_undefined = true;
    }

    if (ctx.rpath) |path| compile.root_module.addRPath(.{ .cwd_relative = path });

    for (source_sets) |set| {
        try attachSources(b, compile, set, options);
    }
}

/// The command line for one source set, in one language.
///
/// Order matters: `-std=` first, then the artifact's flags, then the
/// language-specific ones, then the set's own — so that the most specific
/// setting is the last one the compiler sees, and wins.
fn flagsFor(b: *std.Build, options: Options, set: SourceSet, language: enum { c, cpp }) ![]const []const u8 {
    var list: std.ArrayList([]const u8) = .empty;

    const std_flag = switch (language) {
        .c => options.c_std,
        .cpp => options.cpp_std,
    };
    if (std_flag) |value| try list.append(b.allocator, b.fmt("-std={s}", .{value}));

    // A set that opted out of warnings gets none of them. Vendored code has
    // warnings you cannot fix, and -Wpedantic in particular is fatal on some
    // of it, so silence has to be available per set rather than per artifact.
    if (set.warnings orelse true) {
        if (options.warnings) try list.appendSlice(b.allocator, &.{ "-Wall", "-Wextra" });
        if (options.pedantic) try list.append(b.allocator, "-Wpedantic");
        if (options.warnings_as_errors) try list.append(b.allocator, "-Werror");
    }

    if (!options.exceptions and language == .cpp) try list.append(b.allocator, "-fno-exceptions");

    try list.appendSlice(b.allocator, options.flags);
    try list.appendSlice(b.allocator, switch (language) {
        .c => options.c_flags,
        .cpp => options.cpp_flags,
    });
    try list.appendSlice(b.allocator, set.flags);

    return list.toOwnedSlice(b.allocator);
}

/// Adds one source set, splitting it by language so that `-std=c17` never
/// reaches a C++ file and `-std=c++20` never reaches a C one.
fn attachSources(
    b: *std.Build,
    compile: *std.Build.Step.Compile,
    set: SourceSet,
    options: Options,
) !void {
    const collected = try sources.collect(b, set);
    if (collected.files.len == 0) return;

    var c_files: std.ArrayList([]const u8) = .empty;
    var cpp_files: std.ArrayList([]const u8) = .empty;
    for (collected.files) |file| {
        if (sources.isCpp(file)) {
            try cpp_files.append(b.allocator, file);
        } else {
            try c_files.append(b.allocator, file);
        }
    }

    const root = if (set.dir) |dir| b.path(dir) else b.path(".");

    if (c_files.items.len > 0) {
        compile.addCSourceFiles(.{
            .root = root,
            .files = try c_files.toOwnedSlice(b.allocator),
            .flags = try flagsFor(b, options, set, .c),
        });
    }
    if (cpp_files.items.len > 0) {
        compile.addCSourceFiles(.{
            .root = root,
            .files = try cpp_files.toOwnedSlice(b.allocator),
            .flags = try flagsFor(b, options, set, .cpp),
        });
    }
}

fn linkWindowsHost(
    b: *std.Build,
    ctx: *Context,
    compile: *std.Build.Step.Compile,
    target: std.Build.ResolvedTarget,
    host_executable: []const u8,
) !void {
    if (ctx.node_api_def) |def| {
        compile.addObjectFile(napi.importLibraryFromDef(b, target, def, host_executable));
        return;
    }
    if (std.mem.eql(u8, host_executable, "node.exe")) {
        if (ctx.node_lib) |lib| {
            compile.addObjectFile(.{ .cwd_relative = lib });
            return;
        }
    }
    std.debug.panic(
        "c-cpp-zig-build: building a Windows addon for {s} needs an import library. " ++
            "Pass -Dnode-api-def=<node_api.def> (works for Node and Bun) or " ++
            "-Dnode-lib=<node.lib> (Node only).",
        .{host_executable},
    );
}

fn install(
    b: *std.Build,
    compile: *std.Build.Step.Compile,
    kind: Kind,
    options: Options,
    out_name: ?[]const u8,
) void {
    if (kind != .node_addon and !options.flat) {
        b.installArtifact(compile);
        return;
    }

    // Node insists on the `.node` suffix, and Zig would otherwise install the
    // addon as `lib<name>.so`. A flat library keeps the name Zig gave it.
    const name = out_name orelse switch (kind) {
        .node_addon => b.fmt("{s}.node", .{options.name}),
        else => compile.out_filename,
    };
    const step = b.addInstallFileWithDir(compile.getEmittedBin(), .prefix, name);
    b.getInstallStep().dependOn(&step.step);

    if (kind != .node_addon and compile.isDynamicLibrary() and
        compile.rootModuleTarget().os.tag == .windows)
    {
        // A Windows DLL is useless to a linker without its import library.
        const implib = b.addInstallFileWithDir(
            compile.getEmittedImplib(),
            .prefix,
            compile.out_lib_filename,
        );
        b.getInstallStep().dependOn(&implib.step);
    }
}

fn dirExists(b: *std.Build, rel_path: []const u8) bool {
    var dir = b.build_root.handle.openDir(rel_path, .{}) catch return false;
    dir.close();
    return true;
}
