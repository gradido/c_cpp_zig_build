/*
 * The Node-API layer: it converts values and does nothing else.
 */

#include <stdlib.h>

#include <node_api.h>

#include "crc32.h"

#define CHECK(env, call)                                     \
  do {                                                       \
    if ((call) != napi_ok) {                                 \
      napi_throw_error((env), NULL, "node-api call failed"); \
      return NULL;                                           \
    }                                                        \
  } while (0)

/** crc32(Buffer | Uint8Array | string) -> number */
static napi_value Crc32(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_type_error(env, NULL, "crc32(data) expects a Buffer, a Uint8Array or a string");
    return NULL;
  }

  const uint8_t *bytes = NULL;
  size_t length = 0;
  char *owned = NULL;

  /* A Node Buffer *is* a Uint8Array, so one typed-array branch covers both.
     Asking napi_is_buffer first would not: it answers yes for any array
     buffer view, which would let a Float64Array through as raw bytes. */
  bool is_typedarray = false;
  CHECK(env, napi_is_typedarray(env, argv[0], &is_typedarray));

  if (is_typedarray) {
    napi_typedarray_type type;
    void *data = NULL;
    CHECK(env, napi_get_typedarray_info(env, argv[0], &type, &length, &data, NULL, NULL));
    if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
      napi_throw_type_error(env, NULL, "crc32 takes a byte array, not a wider typed array");
      return NULL;
    }
    bytes = (const uint8_t *)data;
  } else {
    napi_valuetype type;
    CHECK(env, napi_typeof(env, argv[0], &type));
    if (type != napi_string) {
      napi_throw_type_error(env, NULL, "crc32(data) expects a Buffer, a Uint8Array or a string");
      return NULL;
    }
    /* The string is copied out as UTF-8, so the checksum of a string and of
       Buffer.from(string) agree. */
    size_t needed = 0;
    CHECK(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &needed));
    owned = malloc(needed + 1);
    if (owned == NULL) {
      napi_throw_error(env, NULL, "out of memory");
      return NULL;
    }
    if (napi_get_value_string_utf8(env, argv[0], owned, needed + 1, &length) != napi_ok) {
      free(owned);
      napi_throw_error(env, NULL, "node-api call failed");
      return NULL;
    }
    bytes = (const uint8_t *)owned;
  }

  const uint32_t checksum = crc32_bytes(bytes, length);
  free(owned);

  napi_value result;
  CHECK(env, napi_create_uint32(env, checksum, &result));
  return result;
}

NAPI_MODULE_INIT(/* env, exports */) {
  napi_property_descriptor properties[] = {
      {"crc32", NULL, Crc32, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 1, properties) != napi_ok) {
    napi_throw_error(env, NULL, "failed to define module properties");
    return NULL;
  }
  return exports;
}
