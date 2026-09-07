#include "crc32.h"

/*
 * Bitwise CRC-32, without a lookup table: short enough to read in one sitting,
 * and quick enough for a build manifest. The point of this package is what
 * turbo does with the compiled result, not the checksum itself.
 */
uint32_t crc32_bytes(const uint8_t *data, size_t length) {
  uint32_t crc = 0xffffffffu;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ ((crc & 1u) ? 0xedb88320u : 0u);
    }
  }
  return ~crc;
}
