import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parsePublicKey, parseSignature, verifyFile, ZIG_PUBLIC_KEY } from '../lib/minisign.js'

/** The 32 raw Ed25519 bytes of a key, extracted from its DER encoding. */
function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32)
}

/**
 * Builds a minisign keypair and a signing function, so that the happy path can
 * be tested without reaching for the network or for Zig's private key.
 */
function makeSigner({ keyId = crypto.randomBytes(8) } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const encodedPublicKey = Buffer.concat([
    Buffer.from('Ed', 'latin1'),
    keyId,
    rawPublicKey(publicKey),
  ]).toString('base64')

  /**
   * @param {Buffer} contents the file being signed
   * @param {string} trustedComment
   */
  const sign = (contents, trustedComment, options = {}) => {
    const prehashed = options.prehashed ?? true
    const signed = prehashed ? crypto.createHash('blake2b512').update(contents).digest() : contents
    const signature = crypto.sign(null, signed, privateKey)
    const globalSignature = crypto.sign(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]),
      privateKey,
    )
    const header = Buffer.concat([
      Buffer.from(prehashed ? 'ED' : 'Ed', 'latin1'),
      options.keyId ?? keyId,
      signature,
    ])
    return [
      'untrusted comment: signature from minisign secret key',
      header.toString('base64'),
      `trusted comment: ${trustedComment}`,
      (options.globalSignature ?? globalSignature).toString('base64'),
      '',
    ].join('\n')
  }

  return { publicKey: encodedPublicKey, sign, keyId }
}

function tempFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'minisign-')), 'archive.tar.xz')
  fs.writeFileSync(file, contents)
  return file
}

test('the pinned Zig key is the one published on ziglang.org', () => {
  // A typo here would be invisible until a signature failed to verify, at
  // which point the natural conclusion would be that the download was bad.
  const { keyId } = parsePublicKey(ZIG_PUBLIC_KEY)
  assert.equal(keyId.toString('hex'), '863aad8d55e700d9')
})

test('a malformed public key is rejected rather than misread', () => {
  assert.throws(() => parsePublicKey('bm90IGEga2V5'), /expected 42 bytes/)
  const wrongAlgorithm = Buffer.concat([Buffer.from('XX', 'latin1'), crypto.randomBytes(40)])
  assert.throws(() => parsePublicKey(wrongAlgorithm.toString('base64')), /unsupported/)
})

test('a valid signature verifies', async () => {
  const { publicKey, sign } = makeSigner()
  const contents = crypto.randomBytes(4096)
  const file = tempFile(contents)
  const signature = sign(contents, 'timestamp:1\tfile:archive.tar.xz\thashed')

  const result = await verifyFile(file, signature, { publicKey })
  assert.match(result.trustedComment, /file:archive\.tar\.xz/)
})

test('the legacy non-prehashed form also verifies', async () => {
  const { publicKey, sign } = makeSigner()
  const contents = crypto.randomBytes(1024)
  const file = tempFile(contents)
  const signature = sign(contents, 'timestamp:1', { prehashed: false })

  await assert.doesNotReject(verifyFile(file, signature, { publicKey }))
})

test('a tampered file is rejected', async () => {
  const { publicKey, sign } = makeSigner()
  const contents = crypto.randomBytes(4096)
  const signature = sign(contents, 'timestamp:1\tfile:archive.tar.xz\thashed')

  const tampered = Buffer.from(contents)
  tampered[100] ^= 0x01
  const file = tempFile(tampered)

  await assert.rejects(verifyFile(file, signature, { publicKey }), /does not match the contents/)
})

test('a signature from another key is rejected', async () => {
  const signer = makeSigner()
  const attacker = makeSigner({ keyId: signer.keyId })
  const contents = crypto.randomBytes(1024)
  const file = tempFile(contents)

  // Same key id, different key: the id is metadata, not proof of anything, so
  // the signature itself has to fail.
  const forged = attacker.sign(contents, 'timestamp:1')
  await assert.rejects(verifyFile(file, forged, { publicKey: signer.publicKey }), /does not match/)
})

test('a mismatched key id is reported as such', async () => {
  const { publicKey, sign } = makeSigner()
  const contents = crypto.randomBytes(1024)
  const file = tempFile(contents)
  const signature = sign(contents, 'timestamp:1', { keyId: crypto.randomBytes(8) })

  await assert.rejects(verifyFile(file, signature, { publicKey }), /different key than expected/)
})

test('an edited trusted comment is rejected by the global signature', async () => {
  const { publicKey, sign } = makeSigner()
  const contents = crypto.randomBytes(1024)
  const file = tempFile(contents)

  const signature = sign(contents, 'timestamp:1\tfile:archive.tar.xz\thashed')
  const edited = signature.replace('file:archive.tar.xz', 'file:something-else.tar.xz')

  await assert.rejects(verifyFile(file, edited, { publicKey }), /trusted comment/)
})

test('a signature made for a different file name is rejected', async () => {
  const { publicKey, sign } = makeSigner()
  const contents = crypto.randomBytes(1024)
  const file = tempFile(contents)
  // Correctly signed, but for another release: the content check cannot catch
  // this, because the content really is what was signed.
  const signature = sign(contents, 'timestamp:1\tfile:zig-0.14.0.tar.xz\thashed')

  await assert.rejects(
    verifyFile(file, signature, { publicKey, expectedFileName: 'zig-0.15.2.tar.xz' }),
    /signature is for a different file/,
  )
})

test('a truncated signature file is rejected rather than misparsed', () => {
  assert.throws(() => parseSignature('untrusted comment: x\n'), /four lines/)
  assert.throws(
    () => parseSignature(['untrusted comment: x', 'AAAA', 'trusted comment: y', 'BBBB'].join('\n')),
    /expected 74 bytes/,
  )
})
