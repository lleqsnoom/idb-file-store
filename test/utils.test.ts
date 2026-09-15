import { describe, expect, it } from 'vitest';
import {
  boundedLevenshtein,
  contentHash,
  decodeCursor,
  encodeCursor,
  extensionFromMime,
  extensionOf,
  fitWithin,
  formatBytes,
  isInsideFolder,
  isTextLikeMime,
  kindFromMime,
  mimeFromName,
  normalizeChunkSize,
  normalizeFolder,
  normalizeMime,
  normalizeText,
  planIndex,
  resolveSearch,
  scoreRecord,
  tokenize,
  ValidationError,
} from '../src/index.js';
import { DEFAULT_CHUNK_SIZE } from '../src/storage/chunk-store.js';
import { normalizeMetadata, toJsonValue } from '../src/utils/path.js';
import type { StoredFile } from '../src/storage/records.js';

describe('mime helpers', () => {
  it('maps extensions to MIME types', () => {
    expect(mimeFromName('photo.JPG')).toBe('image/jpeg');
    expect(mimeFromName('clip.mov')).toBe('video/quicktime');
    expect(mimeFromName('archive.tar.gz')).toBe('application/gzip');
    expect(mimeFromName('mystery.unknown')).toBe('application/octet-stream');
    expect(extensionOf('a/b/report.docx')).toBe('docx');
    expect(extensionOf('no-extension')).toBe('');
    expect(extensionFromMime('image/png')).toBe('png');
    expect(extensionFromMime('video/mp4')).toBe('mp4');
    expect(extensionFromMime('application/x-nothing')).toBe('');
  });

  it('buckets MIME types into kinds', () => {
    expect(kindFromMime('image/webp')).toBe('image');
    expect(kindFromMime('video/mp4')).toBe('video');
    expect(kindFromMime('audio/mpeg')).toBe('audio');
    expect(kindFromMime('application/pdf')).toBe('document');
    expect(kindFromMime('application/vnd.ms-excel')).toBe('spreadsheet');
    expect(kindFromMime('text/plain')).toBe('text');
    expect(kindFromMime('text/markdown')).toBe('text');
    expect(kindFromMime('application/json')).toBe('code');
    expect(kindFromMime('text/x-python')).toBe('code');
    expect(kindFromMime('application/zip')).toBe('archive');
    expect(kindFromMime('font/woff2')).toBe('font');
    expect(kindFromMime('application/x-whatever')).toBe('other');
  });

  it('normalises MIME parameters and casing', () => {
    expect(normalizeMime('Text/Plain; charset=UTF-8')).toBe('text/plain');
    expect(isTextLikeMime('text/csv')).toBe(true);
    expect(isTextLikeMime('application/json; charset=utf-8')).toBe(true);
    expect(isTextLikeMime('image/png')).toBe(false);
  });
});

describe('folder helpers', () => {
  it('normalises folder paths', () => {
    expect(normalizeFolder(undefined)).toBe('/');
    expect(normalizeFolder('')).toBe('/');
    expect(normalizeFolder('photos')).toBe('/photos');
    expect(normalizeFolder('/photos/2024/')).toBe('/photos/2024');
    expect(normalizeFolder('photos//2024///')).toBe('/photos/2024');
    expect(normalizeFolder('  /a/ ./b  ')).toBe('/a/b');
  });

  it('rejects unusable folder paths', () => {
    expect(() => normalizeFolder('/bad\u0000name')).toThrow(ValidationError);
    expect(() => normalizeFolder(`/${'x'.repeat(1100)}`)).toThrow(ValidationError);
  });

  it('detects nested folders', () => {
    expect(isInsideFolder('/a/b/c', '/a')).toBe(true);
    expect(isInsideFolder('/a', '/a')).toBe(true);
    expect(isInsideFolder('/ab', '/a')).toBe(false);
    expect(isInsideFolder('/anything', '/')).toBe(true);
  });
});

describe('metadata guards', () => {
  it('accepts JSON-safe values', () => {
    expect(toJsonValue('x', 'k')).toBe('x');
    expect(toJsonValue(3, 'k')).toBe(3);
    expect(toJsonValue(null, 'k')).toBeNull();
    expect(toJsonValue([1, 'a', true], 'k')).toEqual([1, 'a', true]);
    expect(toJsonValue(new Date(0), 'k')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('rejects values a structured clone would lose', () => {
    expect(() => toJsonValue(undefined, 'k')).toThrow(ValidationError);
    expect(() => toJsonValue(Number.NaN, 'k')).toThrow(ValidationError);
    expect(() => toJsonValue(() => 1, 'k')).toThrow(ValidationError);
    expect(() => toJsonValue(new Blob(['x']), 'k')).toThrow(ValidationError);
  });

  it('drops undefined entries while normalising', () => {
    expect(normalizeMetadata({ a: 1, b: undefined, c: { d: 2 } })).toEqual({ a: 1, c: { d: 2 } });
    expect(normalizeMetadata(undefined)).toEqual({});
  });
});

describe('text helpers', () => {
  it('normalises case, accents and whitespace', () => {
    expect(normalizeText('  Héllo   WORLD ')).toBe('hello world');
  });

  it('tokenises punctuation, camelCase and unicode', () => {
    expect(tokenize('Holiday-Photos_2024.jpeg')).toEqual(['holiday', 'photos', '2024', 'jpeg']);
    expect(tokenize('camelCaseName')).toEqual(['camel', 'case', 'name']);
    expect(tokenize('zażółć gęślą')).toEqual(['zazolc', 'gesla']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('computes a bounded edit distance', () => {
    expect(boundedLevenshtein('beach', 'beach', 1)).toBe(0);
    expect(boundedLevenshtein('beach', 'bech', 1)).toBe(1);
    expect(boundedLevenshtein('beach', 'bench', 1)).toBe(1);
    expect(boundedLevenshtein('beach', 'xyzzy', 1)).toBe(2);
  });
});

describe('cursors', () => {
  it('round-trips a cursor payload', () => {
    const cursor = encodeCursor(['beach.jpg', 1234], 'id-1');
    expect(cursor).not.toMatch(/[+/=]/);
    expect(decodeCursor(cursor)).toEqual({ v: 1, k: ['beach.jpg', 1234], id: 'id-1' });
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeCursor('!!!!')).toThrow(ValidationError);
    expect(() => decodeCursor(encodeUri('{"v":2,"k":[],"id":"a"}'))).toThrow(ValidationError);
    expect(() => decodeCursor(encodeUri('{"v":1,"k":"no","id":"a"}'))).toThrow(ValidationError);
    expect(() => decodeCursor(encodeUri('"a string"'))).toThrow(ValidationError);
  });
});

function encodeUri(text: string): string {
  // Mirrors the library's base64url encoding so the test stays independent of it.
  const bytes = new TextEncoder().encode(text);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += alphabet[b2 & 0x3f];
  }
  return out;
}

describe('index planning', () => {
  it('plans a full scan for an empty filter', () => {
    // `{}` still means "live only", so it narrows to the trash index.
    expect(planIndex(undefined).index).toBe('by_deleted');
    expect(planIndex({}).index).toBe('by_deleted');
  });

  it('prefers the most selective clause', () => {
    expect(planIndex({ id: 'abc' }).range?.lower).toBe('abc');
    expect(planIndex({ name: { startsWith: 'beach' } }).index).toBe('by_name');
    expect(planIndex({ mime: 'image/png' }).index).toBe('by_mime');
    expect(planIndex({ extension: 'png' }).index).toBe('by_extension');
    expect(planIndex({ hash: 'sha256:abc' }).index).toBe('by_hash');
    expect(planIndex({ kind: 'image' }).index).toBe('by_kind');
    expect(planIndex({ folder: '/a' }).index).toBe('by_folder');
    expect(planIndex({ createdAt: { gte: 1 } }).index).toBe('by_created');
    expect(planIndex({ size: { lt: 100 } }).index).toBe('by_size');
    expect(planIndex({ favorite: true }).index).toBe('by_favorite');
    expect(planIndex({ tags: ['trip'] }).index).toBe('by_tags');
  });

  it('only uses the tag index when it cannot hide matches', () => {
    expect(planIndex({ tags: { all: ['a', 'b'] } }).index).toBe('by_tags');
    expect(planIndex({ tags: { any: ['a'] } }).index).toBe('by_tags');
    expect(planIndex({ tags: { any: ['a', 'b'] } }).index).toBe('by_deleted');
    expect(planIndex({ tags: { none: ['a'] } }).index).toBe('by_deleted');
  });

  it('builds inclusive and exclusive ranges', () => {
    const lowerOpen = planIndex({ size: { gt: 10 } }).range;
    expect(lowerOpen?.lowerOpen).toBe(true);
    const upperOpen = planIndex({ size: { lt: 10 } }).range;
    expect(upperOpen?.upperOpen).toBe(true);
    const bounded = planIndex({ size: { between: [1, 2] } }).range;
    expect(bounded?.lower).toBe(1);
    expect(bounded?.upper).toBe(2);
  });

  it('accepts Dates in range filters', () => {
    const range = planIndex({ createdAt: { gte: new Date(5) } }).range;
    expect(range?.lower).toBe(5);
  });
});

describe('search resolution and scoring', () => {
  const base = {
    nameLower: 'beach sunset',
    notesLower: '',
    textLower: '',
    tagsLower: 'trip',
    metaText: '',
    mime: 'image/jpeg',
    folder: '/photos',
  } as unknown as StoredFile;

  it('returns null for empty queries', () => {
    expect(resolveSearch(undefined)).toBeNull();
    expect(resolveSearch('   ')).toBeNull();
  });

  it('scores name matches above tag matches', () => {
    const search = resolveSearch('beach')!;
    const byName = scoreRecord(base, search);
    const byTag = scoreRecord({ ...base, nameLower: 'other' } as StoredFile, resolveSearch('trip')!);
    expect(byName).toBeGreaterThan(0);
    expect(byName).toBeGreaterThan(byTag ?? 0);
  });

  it('returns null when a required token is missing', () => {
    const search = resolveSearch('beach mountain')!;
    expect(scoreRecord(base, search)).toBeNull();
    const anySearch = resolveSearch({ text: 'beach mountain', mode: 'any' })!;
    expect(scoreRecord(base, anySearch)).toBeGreaterThan(0);
  });

  it('respects the field allow-list', () => {
    expect(scoreRecord(base, resolveSearch({ text: 'trip', fields: ['name'] })!)).toBeNull();
    expect(scoreRecord(base, resolveSearch({ text: 'trip', fields: ['tags'] })!)).toBeGreaterThan(0);
  });

  it('boosts scores', () => {
    const plain = scoreRecord(base, resolveSearch('beach')!) as number;
    const boosted = scoreRecord(base, resolveSearch({ text: 'beach', boost: 2 })!) as number;
    expect(boosted).toBeCloseTo(plain * 2, 5);
  });
});

describe('misc utilities', () => {
  it('clamps chunk sizes', () => {
    expect(normalizeChunkSize(undefined)).toBe(DEFAULT_CHUNK_SIZE);
    expect(normalizeChunkSize(1024)).toBe(1024);
    expect(normalizeChunkSize(1e12)).toBe(256 * 1024 * 1024);
    expect(() => normalizeChunkSize(0)).toThrow(ValidationError);
    expect(() => normalizeChunkSize(-5)).toThrow(ValidationError);
  });

  it('fits images into a bounding box without upscaling', () => {
    expect(fitWithin(1000, 500, 256)).toEqual({ width: 256, height: 128 });
    expect(fitWithin(100, 50, 256)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(0, 0, 256)).toEqual({ width: 0, height: 0 });
  });

  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024 * 3, 1)).toBe('3 MB');
  });

  it('hashes deterministically and differently per payload', async () => {
    const a = await contentHash(new Blob(['alpha']));
    const b = await contentHash(new Blob(['alpha']));
    const c = await contentHash(new Blob(['beta']));

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^(sha256|fnv128x):[0-9a-f]+$/);
  });
});
