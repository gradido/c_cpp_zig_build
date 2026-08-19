/*
 * The Node-API layer: it converts values and does nothing else. Keeping the
 * real work in src/ is what lets the same code be linked into a test binary,
 * a command line tool, or another language's bindings.
 */

#include <node_api.h>

#include "mathx.h"

#define CHECK(env, call)                                       \
  do {                                                         \
    if ((call) != napi_ok) {                                   \
      napi_throw_error((env), NULL, "node-api call failed");   \
      return NULL;                                             \
    }                                                          \
  } while (0)

static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 2) {
    napi_throw_type_error(env, NULL, "add(a, b) expects two numbers");
    return NULL;
  }

  int64_t a = 0;
  int64_t b = 0;
  CHECK(env, napi_get_value_int64(env, argv[0], &a));
  CHECK(env, napi_get_value_int64(env, argv[1], &b));

  napi_value result;
  CHECK(env, napi_create_int64(env, mathx_add(a, b), &result));
  return result;
}

static napi_value Fib(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  int32_t n = 0;
  if (argc >= 1) {
    CHECK(env, napi_get_value_int32(env, argv[0], &n));
  }

  /* Fibonacci outgrows a double well before it outgrows a uint64, so the
     result is handed over as a BigInt rather than quietly losing precision. */
  napi_value result;
  CHECK(env, napi_create_bigint_uint64(env, mathx_fib(n), &result));
  return result;
}

NAPI_MODULE_INIT(/* env, exports */) {
  napi_property_descriptor properties[] = {
      {"add", NULL, Add, NULL, NULL, NULL, napi_default, NULL},
      {"fib", NULL, Fib, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, NULL, "failed to define module properties");
    return NULL;
  }
  return exports;
}
