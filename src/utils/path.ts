import { ValidationError } from '../errors.js';
import type { JsonValue } from '../types.js';

/**
 * Folder path and metadata helpers.
 */

/** Normalises a folder path to `/a/b` form. Empty input becomes `/`. */
export function normalizeFolder(input: string | undefined | null): string {
  if (!input) return '/';
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.');
  const normalized = `/${parts.join('/')}`;

  if (/[\u0000-\u001f]/.test(normalized)) {
    throw new ValidationError('Folder paths cannot contain control characters');
  }
  if (normalized.length > 1024) {
    throw new ValidationError('Folder paths cannot exceed 1024 characters');
  }
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

/** `true` when `folder` is `ancestor` or lives below it. */
export function isInsideFolder(folder: string, ancestor: string): boolean {
  const target = normalizeFolder(folder);
  const base = normalizeFolder(ancestor);
  if (base === '/') return true;
  return target === base || target.startsWith(`${base}/`);
}

/** Reads a value from a nested object using a dotted path (`exif.iso`). */
export function getByPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Validates that a value can be stored as metadata.
 *
 * Metadata must survive a structured clone and a JSON round trip, so dates are
 * converted to ISO strings, `undefined` is rejected, and binary payloads are
 * refused with a pointer to the right API.
 *
 * @param value - The candidate value.
 * @param path - Dotted path used to build a helpful error message.
 */
export function toJsonValue(value: unknown, path: string): JsonValue {
  if (value === undefined) {
    throw new ValidationError(`metadata["${path}"] is undefined; use null instead`);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new ValidationError(`metadata["${path}"] must be JSON-serialisable`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`metadata["${path}"] must be a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${path}.${index}`));
  }
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Blob || value instanceof ArrayBuffer) {
      throw new ValidationError(
        `metadata["${path}"] cannot hold binary data; store it as a file instead`,
      );
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = toJsonValue(item, `${path}.${key}`);
    }
    return out;
  }
  return null;
}

/** Sanitises a whole metadata object, dropping `undefined` entries. */
export function normalizeMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, JsonValue> {
  if (!input) return {};
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key] = toJsonValue(value, key);
  }
  return out;
}

/** Collects every primitive value inside a metadata object as searchable text. */
export function metadataToSearchText(metadata: Record<string, JsonValue>): string {
  const parts: string[] = [];
  const visit = (value: JsonValue, keyHint: string): void => {
    if (value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, key);
      return;
    }
    parts.push(keyHint, String(value));
  };
  for (const [key, value] of Object.entries(metadata)) visit(value, key);
  return parts.join(' ');
}