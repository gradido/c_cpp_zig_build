/*
 * A Node addon over zstd, which is not vendored anywhere in this project: it
 * arrives as a Zig package, declared in build.zig.zon and linked in build.zig.
 * `zig fetch --save` is the only thing that touched this repository.
 */

#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>

#include <zstd.h>

static napi_value ThrowZstd(napi_env env, size_t code, const char *what) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", what, ZSTD_getErrorName(code));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static bool GetBuffer(napi_env env, napi_value value, void **data, size_t *len) {
  bool is_buffer = false;
  napi_is_buffer(env, value, &is_buffer);
  if (!is_buffer) {
    napi_throw_type_error(env, NULL, "expected a Buffer");
    return false;
  }
  return napi_get_buffer_info(env, value, data, len) == napi_ok;
}

static napi_value Compress(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "compress(buffer, level?) expects a Buffer");
    return NULL;
  }

  void *input = NULL;
  size_t input_len = 0;
  if (!GetBuffer(env, argv[0], &input, &input_len)) return NULL;

  int32_t level = ZSTD_defaultCLevel();
  if (argc >= 2) napi_get_value_int32(env, argv[1], &level);

  const size_t bound = ZSTD_compressBound(input_len);
  void *output = NULL;
  napi_value result;
  /* Letting Node own the memory means one allocation instead of two and no
     copy on the way out. */
  if (napi_create_buffer(env, bound, &output, &result) != napi_ok) return NULL;

  const size_t written = ZSTD_compress(output, bound, input, input_len, level);
  if (ZSTD_isError(written)) return ThrowZstd(env, written, "compress failed");

  napi_value sliced;
  if (napi_create_buffer_copy(env, written, output, NULL, &sliced) != napi_ok) return NULL;
  return sliced;
}

static napi_value Decompress(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "decompress(buffer) expects a Buffer");
    return NULL;
  }

  void *input = NULL;
  size_t input_len = 0;
  if (!GetBuffer(env, argv[0], &input, &input_len)) return NULL;

  const unsigned long long size = ZSTD_getFrameContentSize(input, input_len);
  if (size == ZSTD_CONTENTSIZE_ERROR || size == ZSTD_CONTENTSIZE_UNKNOWN) {
    napi_throw_error(env, NULL, "not a zstd frame with a known content size");
    return NULL;
  }

  void *output = NULL;
  napi_value result;
  if (napi_create_buffer(env, (size_t)size, &output, &result) != napi_ok) return NULL;

  const size_t written = ZSTD_decompress(output, (size_t)size, input, input_len);
  if (ZSTD_isError(written)) return ThrowZstd(env, written, "decompress failed");
  return result;
}

static napi_value Version(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_create_string_utf8(env, ZSTD_versionString(), NAPI_AUTO_LENGTH, &result);
  return result;
}

NAPI_MODULE_INIT(/* env, exports */) {
  napi_property_descriptor properties[] = {
      {"compress", NULL, Compress, NULL, NULL, NULL, napi_default, NULL},
      {"decompress", NULL, Decompress, NULL, NULL, NULL, napi_default, NULL},
      {"version", NULL, Version, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) {
    napi_throw_error(env, NULL, "failed to define module properties");
    return NULL;
  }
  return exports;
}
