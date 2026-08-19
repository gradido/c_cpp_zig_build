/**
 * Minisign signature verification.
 *
 * Zig signs every release archive with minisign and publishes the signature
 * next to it. Checking that signature is what makes downloading from a
 * community mirror safe: a mirror can serve any bytes it likes, but it cannot
 * forge an Ed25519 signature made with Zig's key.
 *
 * The checksum from ziglang.org's index is a second, independent check —
 * neither replaces the other. The checksum proves "this is the file
 * ziglang.org listed"; the signature proves "this file was built and signed by
 * the Zig project".
 *
 * Implemented here rather than shelling out to `minisign`, which is not
 * installed on most machines, or taking a dependency for 90 lines of Ed25519
 * plumbing that Node already provides.
 *
 * Format reference: https://jedisct1.github.io/minisign/
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * The Zig project's public signing key, as published on
 * https://ziglang.org/download/.
 *
 * Pinned here on purpose. Fetching it at run time from the same place as the
 * archives would make it worth exactly as much as the archives themselves.
 */
export const ZIG_PUBLIC_KEY = 'RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U'

/** Ed25519 signature over the file itself. */
const ALGORITHM_LEGACY = 'Ed'
/** Ed25519 signature over the BLAKE2b-512 hash of the file. What Zig uses. */
const ALGORITHM_PREHASHED = 'ED'

/** DER prefix that turns 32 raw Ed25519 key bytes into an SPKI public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Decodes a minisign public key.
 *
 * @param {string} encoded the single-line base64 key, `RW...`
 * @returns {{ keyId: Buffer, key: import('node:crypto').KeyObject }}
 */
export function parsePublicKey(encoded) {
  const raw = Buffer.from(encoded.trim(), 'base64')
  if (raw.length !== 42) {
    throw new Error(`malformed minisign public key: expected 42 bytes, got ${raw.length}`)
  }
  const algorithm = raw.subarray(0, 2).toString('latin1')
  if (algorithm !== ALGORITHM_LEGACY) {
    throw new Error(`unsupported minisign public key algorithm '${algorithm}'`)
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  }
}

/**
 * Parses a `.minisig` file.
 *
 * @param {string} text
 * @returns {{
 *   prehashed: boolean,
 *   keyId: Buffer,
 *   signature: Buffer,
 *   trustedComment: string,
 *   globalSignature: Buffer,
 * }}
 */
export function parseSignature(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length < 4) {
    throw new Error('malformed minisign signature: expected four lines')
  }

  const raw = Buffer.from(lines[1].trim(), 'base64')
  if (raw.length !== 74) {
    throw new Error(`malformed minisign signature: expected 74 bytes, got ${raw.length}`)
  }

  const algorithm = raw.subarray(0, 2).toString('latin1')
  if (algorithm !== ALGORITHM_PREHASHED && algorithm !== ALGORITHM_LEGACY) {
    throw new Error(`unsupported minisign signature algorithm '${algorithm}'`)
  }

  const trustedCommentLine = lines[2]
  const marker = 'trusted comment: '
  if (!trustedCommentLine.startsWith(marker)) {
    throw new Error('malformed minisign signature: no trusted comment')
  }

  return {
    prehashed: algorithm === ALGORITHM_PREHASHED,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trustedCommentLine.slice(marker.length),
    globalSignature: Buffer.from(lines[3].trim(), 'base64'),
  }
}

/**
 * Verifies a downloaded file against a minisign signature.
 *
 * Three things are checked, and all three must hold:
 *
 *   1. the signature was made with the expected key;
 *   2. the signature covers this file's content;
 *   3. the *global* signature covers the trusted comment, so the file name and
 *      timestamp recorded in it cannot be edited after the fact.
 *
 * @param {string} filePath
 * @param {string} signatureText contents of the `.minisig` file
 * @param {{ publicKey?: string, expectedFileName?: string }} [options]
 * @returns {Promise<{ trustedComment: string }>}
 * @throws when any check fails
 */
export async function verifyFile(filePath, signatureText, options = {}) {
  const { keyId, key } = parsePublicKey(options.publicKey ?? ZIG_PUBLIC_KEY)
  const signature = parseSignature(signatureText)

  if (!keyId.equals(signature.keyId)) {
    throw new Error(
      'signature was made with a different key than expected\n' +
        `  expected key id ${keyId.toString('hex')}\n` +
        `  signature key id ${signature.keyId.toString('hex')}`,
    )
  }

  // The prehashed form signs a BLAKE2b-512 digest, which is what lets a
  // multi-gigabyte file be verified without being held in memory.
  const signed = signature.prehashed
    ? await hashFile(filePath, 'blake2b512')
    : await readFile(filePath)

  if (!verifySignature(null, signed, key, signature.signature)) {
    throw new Error(`signature does not match the contents of ${filePath}`)
  }

  const globallySigned = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, 'utf8'),
  ])
  if (!verifySignature(null, globallySigned, key, signature.globalSignature)) {
    throw new Error('the trusted comment of the signature is not itself signed')
  }

  // The trusted comment names the file it was made for. The content check
  // above already rules out a substituted file, but this rules out a signature
  // lifted from a different release of the same project.
  if (options.expectedFileName) {
    const named = /(?:^|\t)file:([^\t]+)/.exec(signature.trustedComment)?.[1]
    if (named && named !== options.expectedFileName) {
      throw new Error(
        `the signature is for a different file\n` +
          `  expected ${options.expectedFileName}\n` +
          `  signed   ${named}`,
      )
    }
  }

  return { trustedComment: signature.trustedComment }
}

/**
 * Hashes a file by streaming it, so that memory use does not scale with the
 * size of the download.
 *
 * @param {string} filePath
 * @param {string} algorithm
 * @returns {Promise<Buffer>}
 */
export function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest()))
  })
}

async function readFile(filePath) {
  const { readFile: read } = await import('node:fs/promises')
  return read(filePath)
}
