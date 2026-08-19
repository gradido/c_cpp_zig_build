/* The Node-API surface over the core library in src/. */

#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "digest.h"

static bool SetU64(napi_env env, napi_value object, const char *key, uint64_t value) {
  napi_value number;
  if (napi_create_bigint_uint64(env, value, &number) != napi_ok) return false;
  return napi_set_named_property(env, object, key, number) == napi_ok;
}

static bool SetSize(napi_env env, napi_value object, const char *key, size_t value) {
  napi_value number;
  if (napi_create_int64(env, (int64_t)value, &number) != napi_ok) return false;
  return napi_set_named_property(env, object, key, number) == napi_ok;
}

static napi_value Measure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "measure(text) expects a string or a Buffer");
    return NULL;
  }

  /* Buffers are handed over without a copy; strings need one, because the
     engine stores them in its own encoding. */
  void *buffer_data = NULL;
  size_t buffer_len = 0;
  bool is_buffer = false;
  napi_is_buffer(env, argv[0], &is_buffer);

  char *owned = NULL;
  if (is_buffer) {
    if (napi_get_buffer_info(env, argv[0], &buffer_data, &buffer_len) != napi_ok) return NULL;
  } else {
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &len) != napi_ok) {
      napi_throw_type_error(env, NULL, "measure(text) expects a string or a Buffer");
      return NULL;
    }
    owned = malloc(len + 1);
    if (owned == NULL) {
      napi_throw_error(env, NULL, "out of memory");
      return NULL;
    }
    if (napi_get_value_string_utf8(env, argv[0], owned, len + 1, &len) != napi_ok) {
      free(owned);
      return NULL;
    }
    buffer_data = owned;
    buffer_len = len;
  }

  const digest_stats stats = digest_measure((const char *)buffer_data, buffer_len);
  free(owned);

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  if (!SetU64(env, result, "hash", stats.hash)) return NULL;
  if (!SetSize(env, result, "bytes", stats.bytes)) return NULL;
  if (!SetSize(env, result, "lines", stats.lines)) return NULL;
  if (!SetSize(env, result, "longestLine", stats.longest_line)) return NULL;
  return result;
}

static napi_value Seed(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  if (napi_create_bigint_uint64(env, digest_seed(), &result) != napi_ok) return NULL;
  return result;
}

NAPI_MODULE_INIT(/* env, exports */) {
  napi_property_descriptor properties[] = {
      {"measure", NULL, Measure, NULL, NULL, NULL, napi_default, NULL},
      {"seed", NULL, Seed, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, NULL, "failed to define module properties");
    return NULL;
  }
  return exports;
}
