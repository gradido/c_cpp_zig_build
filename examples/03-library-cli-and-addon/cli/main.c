/*
 * The same core library behind a command line tool.
 *
 * This is the reason for splitting src/ from napi/: the logic is testable and
 * profilable without a JavaScript runtime in the way.
 */

#include <stdio.h>
#include <stdlib.h>

#include "digest.h"

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <file>\n", argv[0]);
    return 2;
  }

  FILE *file = fopen(argv[1], "rb");
  if (file == NULL) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }

  fseek(file, 0, SEEK_END);
  const long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  if (size < 0) {
    fclose(file);
    fprintf(stderr, "cannot measure %s\n", argv[1]);
    return 1;
  }

  char *data = malloc((size_t)size + 1);
  if (data == NULL) {
    fclose(file);
    fprintf(stderr, "out of memory\n");
    return 1;
  }
  const size_t read = fread(data, 1, (size_t)size, file);
  fclose(file);

  const digest_stats stats = digest_measure(data, read);
  free(data);

  printf("hash         %016llx\n", (unsigned long long)stats.hash);
  printf("bytes        %zu\n", stats.bytes);
  printf("lines        %zu\n", stats.lines);
  printf("longest line %zu\n", stats.longest_line);
  return 0;
}
