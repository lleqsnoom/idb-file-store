import { ValidationError } from '../errors.js';

/**
 * Opaque pagination cursors.
 *
 * A cursor pins the position of the last returned record: the values of every
 * sort field plus the record id as a tie-breaker. Passing it back resumes the
 * listing without re-scanning the records that came before.
 *
 * The payload is base64url-encoded JSON, which keeps it safe to put in a URL
 * query string, in `localStorage`, or in a React state atom.
 */

const CURSOR_VERSION = 1;

/** Decoded cursor contents. */
export interface CursorPayload {
  /** Cursor format version. */
  v: number;
  /** Sort key values of the record the cursor points after. */
  k: (string | number | null)[];
  /** Id of the record the cursor points after. */
  id: string;
}

/** Encodes a cursor key into an opaque string. */
export function encodeCursor(key: readonly (string | number)[], id: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, k: [...key], id };
  return base64UrlEncode(JSON.stringify(payload));
}

/** Decodes a cursor, throwing a {@link ValidationError} when it is malformed. */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(cursor));
  } catch {
    throw new ValidationError('Invalid cursor: it is not a base64url encoded cursor payload');
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new ValidationError('Invalid cursor: expected an object payload');
  }
  const payload = parsed as Partial<CursorPayload>;
  if (payload.v !== CURSOR_VERSION) {
    throw new ValidationError(
      `Invalid cursor: unsupported version ${String(payload.v)}; expected ${CURSOR_VERSION}`,
    );
  }
  if (!Array.isArray(payload.k) || typeof payload.id !== 'string') {
    throw new ValidationError('Invalid cursor: missing key or id');
  }
  return { v: CURSOR_VERSION, k: payload.k, id: payload.id };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function base64UrlDecode(input: string): string {
  const lookup = buildLookup();
  const clean = input.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = lookup.get(char);
    if (value === undefined) throw new ValidationError(`Invalid cursor character: "${char}"`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

let lookupCache: Map<string, number> | null = null;

function buildLookup(): Map<string, number> {
  if (lookupCache) return lookupCache;
  const map = new Map<string, number>();
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    map.set(BASE64_ALPHABET[i] as string, i);
  }
  // Accept standard base64 padding characters so cursors survive a round trip
  // through tools that normalise base64url back to base64.
  map.set('+', 62);
  map.set('/', 63);
  lookupCache = map;
  return map;
}