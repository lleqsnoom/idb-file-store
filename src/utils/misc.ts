import { NotSupportedError } from '../errors.js';

/**
 * Identifier, timing and blob helpers shared across the library.
 */

/** Creates a unique id, preferring `crypto.randomUUID`. */
export function createId(): string {
  const cryptoScope = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoScope?.randomUUID === 'function') return cryptoScope.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoScope?.getRandomValues === 'function') {
    cryptoScope.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Current wall-clock time in milliseconds. */
export function now(): number {
  return Date.now();
}

/** Converts an optional `Date | number` into epoch milliseconds. */
export function toTimestamp(value: Date | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  return Number.isFinite(value) ? value : undefined;
}

/** Coerces any {@link FileInput}-like value into a `Blob`. */
export function toBlob(input: Blob | ArrayBuffer | ArrayBufferView | string, mime?: string): Blob {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return input;
  if (typeof input === 'string') return new Blob([input], { type: mime ?? 'text/plain' });
  if (input instanceof ArrayBuffer) return new Blob([input], { type: mime ?? 'application/octet-stream' });
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    return new Blob([buffer], { type: mime ?? 'application/octet-stream' });
  }
  throw new NotSupportedError('Unsupported input: expected Blob, File, ArrayBuffer, view or string');
}

/** Reads a `File`/`Blob` name when available. */
export function inputName(input: unknown): string | undefined {
  if (typeof File !== 'undefined' && input instanceof File) return input.name;
  return undefined;
}

/** Formats a byte count into a human readable string. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Number(value.toFixed(decimals));
  return `${rounded} ${units[unit]}`;
}

