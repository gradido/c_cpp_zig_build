#include "fasthash.h"

#ifndef FASTHASH_SEED
#define FASTHASH_SEED 0xcbf29ce484222325ULL
#endif

uint64_t fasthash64(const void *data, size_t len) {
  const unsigned char *bytes = (const unsigned char *)data;
  uint64_t hash = (uint64_t)FASTHASH_SEED;
  for (size_t i = 0; i < len; i++) {
    hash ^= (uint64_t)bytes[i];
    hash *= 0x100000001b3ULL;
  }
  return hash;
}

uint64_t fasthash_seed(void) {
  return (uint64_t)FASTHASH_SEED;
}
