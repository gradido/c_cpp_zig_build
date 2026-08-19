/* The public surface of this example: plain C, no Node.js in sight. */
#ifndef MATHX_H
#define MATHX_H

#include <stdint.h>

/** Adds two integers. */
int64_t mathx_add(int64_t a, int64_t b);

/** The n-th Fibonacci number, iteratively. Returns 0 for n < 0. */
uint64_t mathx_fib(int32_t n);

#endif /* MATHX_H */
