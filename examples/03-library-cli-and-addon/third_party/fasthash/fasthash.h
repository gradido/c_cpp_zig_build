/*
 * fasthash - a stand-in for a vendored third-party library.
 *
 * This is what a "file drop" looks like: unpack a library under third_party/,
 * and the build compiles it without any build file being edited. The only
 * thing this one needs is a define, which build.zig passes to this directory
 * alone.
 *
 * SPDX-License-Identifier: CC0-1.0
 */
#ifndef FASTHASH_H
#define FASTHASH_H

#include <stddef.h>
#include <stdint.h>

/** 64-bit FNV-1a over `len` bytes. */
uint64_t fasthash64(const void *data, size_t len);

/** The seed this build was compiled with, so callers can log it. */
uint64_t fasthash_seed(void);

#endif /* FASTHASH_H */
