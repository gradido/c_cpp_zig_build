/* The core library: no Node.js, no third-party types in the signatures. */
#ifndef DIGEST_H
#define DIGEST_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint64_t hash;
  size_t bytes;
  size_t lines;
  size_t longest_line;
} digest_stats;

/** Hashes and measures a buffer in one pass. */
digest_stats digest_measure(const char *data, size_t len);

/** The seed the vendored hash was compiled with. */
uint64_t digest_seed(void);

#endif /* DIGEST_H */
