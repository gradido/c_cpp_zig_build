#include "digest.h"

#include "fasthash.h"

digest_stats digest_measure(const char *data, size_t len) {
  digest_stats stats = {0};
  stats.hash = fasthash64(data, len);
  stats.bytes = len;

  size_t current = 0;
  for (size_t i = 0; i < len; i++) {
    if (data[i] == '\n') {
      stats.lines++;
      if (current > stats.longest_line) stats.longest_line = current;
      current = 0;
    } else {
      current++;
    }
  }
  /* A trailing fragment without a newline still counts as a line. */
  if (current > 0) {
    stats.lines++;
    if (current > stats.longest_line) stats.longest_line = current;
  }
  return stats;
}

uint64_t digest_seed(void) {
  return fasthash_seed();
}
