#include "tallies.h"

int64_t tallies_sum(const int64_t *values, size_t count) {
  int64_t total = 0;
  for (size_t i = 0; i < count; ++i) {
    total += values[i];
  }
  return total;
}
