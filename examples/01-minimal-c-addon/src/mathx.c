#include "mathx.h"

int64_t mathx_add(int64_t a, int64_t b) {
  return a + b;
}

uint64_t mathx_fib(int32_t n) {
  if (n < 0) return 0;
  uint64_t previous = 0;
  uint64_t current = 1;
  for (int32_t i = 0; i < n; i++) {
    const uint64_t next = previous + current;
    previous = current;
    current = next;
  }
  return previous;
}
