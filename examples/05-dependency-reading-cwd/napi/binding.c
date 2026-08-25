/*
 * The Node-API layer: it converts values and calls into the package. There is
 * no src/ in this project, deliberately — see build.zig.
 */

#include <node_api.h>
#include <stdlib.h>

#include "tallies.h"

#define CHECK(env, call)                                     \
  do {                                                       \
    if ((call) != napi_ok) {                                 \
      napi_throw_error((env), NULL, "node-api call failed"); \
      return NULL;                                           \
    }                                                        \
  } while (0)

static napi_value Sum(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  bool is_array = false;
  if (argc < 1 || napi_is_array(env, argv[0], &is_array) != napi_ok || !is_array) {
    napi_throw_type_error(env, NULL, "sum(values) expects an array of numbers");
    return NULL;
  }

  uint32_t count = 0;
  CHECK(env, napi_get_array_length(env, argv[0], &count));

  /* calloc(0, …) may answer NULL without anything being wrong, so an empty
     array is answered before the allocation rather than after it. */
  napi_value result;
  if (count == 0) {
    CHECK(env, napi_create_int64(env, 0, &result));
    return result;
  }

  int64_t *values = calloc(count, sizeof(int64_t));
  if (!values) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }

  for (uint32_t i = 0; i < count; ++i) {
    napi_value element;
    if (napi_get_element(env, argv[0], i, &element) != napi_ok ||
        napi_get_value_int64(env, element, &values[i]) != napi_ok) {
      free(values);
      napi_throw_type_error(env, NULL, "sum(values) expects an array of numbers");
      return NULL;
    }
  }

  const int64_t total = tallies_sum(values, count);
  free(values);

  CHECK(env, napi_create_int64(env, total, &result));
  return result;
}

NAPI_MODULE_INIT(/* env, exports */) {
  napi_property_descriptor properties[] = {
      {"sum", NULL, Sum, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 1, properties) != napi_ok) {
    napi_throw_error(env, NULL, "failed to define module properties");
    return NULL;
  }
  return exports;
}
