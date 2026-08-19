# 02 — C++ with node-addon-api

The same shape as example 1, in C++.

```zig
_ = try znb.addNodeAddon(b, .{
    .name = "matrix_addon",
    .cpp_std = "c++20",
});
```

Two things happen without being asked for:

- **libc++ is linked**, because C++ sources were found. `.link_libcpp` exists
  if you need to override that; you normally do not.
- **`node-addon-api`'s headers are added.** A copy ships with
  `zig-native-build`, so this would compile with no dependencies at all. This
  example declares its own anyway, which is the better habit: a declared
  version wins over the bundled one, and `napi.h` does change between majors.

```bash
npm install       # node-addon-api
npm run build
node --test

npx zig-native-build info   # says which copy of the headers was used
```

## Worth noticing

**C++ exceptions must not escape into JavaScript.** `Matrix::multiply` throws
`std::invalid_argument` on mismatched shapes; the binding catches it and
rethrows it as a `Napi::Error`. Letting it through takes the process down. The
test asserts the JavaScript side sees a normal `Error`.

```cpp
try {
  return ToJs(env, a.multiply(b));
} catch (const std::invalid_argument& error) {
  throw Napi::Error::New(env, error.what());
}
```

**`node-addon-api` throws C++ exceptions to signal JavaScript ones.** That is
why `.exceptions` is left on. If you turn it off, the wrapper switches to
returning `Maybe` values and every call site has to check — set
`.exceptions = false` and the two macros that requires are defined for you.
