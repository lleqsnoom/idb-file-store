/**
 * Content hashing.
 *
 * Uses WebCrypto SHA-256 when the runtime exposes it. Inside insecure contexts
 * (plain `http://`) WebCrypto is unavailable, so the library falls back to a
 * 128-bit FNV-1a style digest. The fallback is fine for de-duplication but is
 * not a cryptographic guarantee, so the returned string is prefixed with the
 * algorithm that produced it.
 */

const HASH_PREFIX_SHA256 = 'sha256:';
const HASH_PREFIX_FNV = 'fnv128x:';
const READ_CHUNK_BYTES = 1024 * 1024;

/** Returns `true` when WebCrypto SHA-256 is usable in this runtime. */
export function supportsWebCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.digest === 'function';
}

/**
 * Hashes the bytes of `blob` and returns `"<algorithm>:<hex>"`.
 *
 * Large payloads are streamed in 1 MiB slices, so hashing a video does not
 * require holding the whole thing in memory twice.
 */
export async function contentHash(blob: Blob): Promise<string> {
  const bytes = await readAllBytes(blob);
  return hashBytes(bytes);
}

/** Returns `sha256:<hex>`, or `fnv128x:<hex>` when WebCrypto is unavailable. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (supportsWebCrypto()) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
    return HASH_PREFIX_SHA256 + toHex(new Uint8Array(digest));
  }
  return HASH_PREFIX_FNV + toHex(fnv128(bytes));
}

/** Reads a blob (or its first `limit` bytes) into a single `Uint8Array`. */
export async function readAllBytes(blob: Blob, limit = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  const size = Math.min(blob.size, limit);
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + READ_CHUNK_BYTES, size);
    const slice = blob.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    out.set(new Uint8Array(buffer), offset);
    offset = end;
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const FNV_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME = 0x0000000001000000000000000000013bn;
const MASK_128 = (1n << 128n) - 1n;

/** Non-cryptographic 128-bit FNV-1a digest, used when WebCrypto is missing. */
function fnv128(bytes: Uint8Array): Uint8Array {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & MASK_128;
    hash = (hash * FNV_PRIME) & MASK_128;
  }
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i -= 1) {
    out[i] = Number(hash & 0xffn);
    hash >>= 8n;
  }
  return out;
}