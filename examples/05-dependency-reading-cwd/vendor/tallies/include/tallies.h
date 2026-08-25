#ifndef TALLIES_H
#define TALLIES_H

#include <stddef.h>
#include <stdint.h>

/** Sum of @p count values. */
int64_t tallies_sum(const int64_t *values, size_t count);

#endif /* TALLIES_H */
