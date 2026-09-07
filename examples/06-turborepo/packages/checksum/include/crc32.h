/* The public surface of this package: plain C, no Node.js in sight. */
#ifndef CRC32_H
#define CRC32_H

#include <stddef.h>
#include <stdint.h>

/** CRC-32 (IEEE 802.3) over `length` bytes of `data`. */
uint32_t crc32_bytes(const uint8_t *data, size_t length);

#endif /* CRC32_H */
