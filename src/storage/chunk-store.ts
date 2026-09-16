import { NotFoundError, ValidationError } from '../errors.js';
import type { StoredChunk } from './records.js';
import { collectFromCursor, type Wait } from './idb.js';
import { CHUNK_INDEX, STORE_CHUNKS } from './schema.js';

/**
 * Chunked blob storage, keyed by content.
 *
 * Bytes are addressed by a **content id**, not by the record that uses them, so two
 * records with identical bytes reference one copy. The content id is the content hash
 * when one was computed and a private id otherwise, which means identical payloads
 * collide on the same keys while unhashed payloads stay independent.
 *
 * Chunks are written once and never rewritten: a record that adopts existing content
 * copies its layout instead of writing its own.
 *
 * Every helper takes the live transaction explicitly, so the caller controls atomicity:
 * checking whether content exists, writing it and writing the record commit together.
 */

/** Default slice size: 2 MiB, a good balance for pictures and long videos. */
export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;

/** Largest slice accepted for a single structured-clone value. */
const MAX_CHUNK_SIZE = 256 * 1024 * 1024;

/** Clamps a requested chunk size into a sane range. */
export function normalizeChunkSize(size: number | undefined): number {
  if (size === undefined) return DEFAULT_CHUNK_SIZE;
  if (!Number.isFinite(size) || size <= 0) {
    throw new ValidationError(`chunkSize must be a positive number, received ${String(size)}`);
  }
  return Math.min(Math.floor(size), MAX_CHUNK_SIZE);
}

/** Number of chunks a payload of `size` bytes will occupy. */
export function chunkCountFor(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** How a content id is laid out on disk. */
export interface ContentLayout {
  chunkCount: number;
  chunkSize: number;
}

/** `true` when the content id already has chunks stored. */
export async function hasContent(
  transaction: IDBTransaction,
  wait: Wait,
  contentId: string,
): Promise<boolean> {
  return (await countChunks(transaction, wait, contentId)) > 0;
}

export function countChunks(
  transaction: IDBTransaction,
  wait: Wait,
  contentId: string,
): Promise<number> {
  const index = transaction.objectStore(STORE_CHUNKS).index(CHUNK_INDEX.contentId);
  return wait(index.count(IDBKeyRange.only(contentId)));
}

/** Writes the bytes of `blob` under `contentId`. Resolves with the layout written. */
export async function writeChunks(
  transaction: IDBTransaction,
  wait: Wait,
  contentId: string,
  blob: Blob,
  chunkSize: number,
): Promise<ContentLayout> {
  const store = transaction.objectStore(STORE_CHUNKS);
  const chunkCount = chunkCountFor(blob.size, chunkSize);
  // Slicing one chunk at a time keeps at most `chunkSize` bytes alive; the puts are
  // issued in parallel so the transaction commits in one round trip.
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize;
    const slice = blob.slice(start, Math.min(start + chunkSize, blob.size), blob.type);
    const chunk: StoredChunk = { contentId, index, data: slice };
    pending.push(wait(store.put(chunk)));
  }
  await Promise.all(pending);
  return { chunkCount, chunkSize };
}

/** Reads every chunk back and reassembles them into a single blob. */
export async function readChunks(
  transaction: IDBTransaction,
  contentId: string,
  mime: string,
  expectedChunks = 0,
): Promise<Blob> {
  const rows = await readContentChunks(transaction, contentId);
  if (rows.length === 0) {
    if (expectedChunks > 0) {
      throw new NotFoundError(`Bytes for content "${contentId}" are missing from the chunk store`);
    }
    return new Blob([], { type: mime });
  }
  return new Blob(
    rows.map((row) => row.data),
    { type: mime },
  );
}

/**
 * Reads a byte range without materialising the whole file. Only the chunks that
 * overlap `[start, end)` are fetched, which is what makes video seeking cheap.
 */
export async function readChunkRange(
  transaction: IDBTransaction,
  wait: Wait,
  contentId: string,
  start: number,
  end: number,
  mime: string,
  chunkSize: number,
): Promise<Blob> {
  if (end <= start) return new Blob([], { type: mime });
  const firstIndex = Math.floor(start / chunkSize);
  const lastIndex = Math.floor((end - 1) / chunkSize);
  const store = transaction.objectStore(STORE_CHUNKS);

  const requests: Promise<StoredChunk | undefined>[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    requests.push(wait(store.get([contentId, index]) as IDBRequest<StoredChunk | undefined>));
  }
  const rows = await Promise.all(requests);

  const parts: Blob[] = [];
  for (let offset = 0; offset < rows.length; offset += 1) {
    const row = rows[offset];
    if (!row) {
      throw new NotFoundError(`Chunk ${firstIndex + offset} of content "${contentId}" is missing`);
    }
    const chunkStart = (firstIndex + offset) * chunkSize;
    const localStart = Math.max(0, start - chunkStart);
    const localEnd = Math.min(row.data.size, end - chunkStart);
    parts.push(row.data.slice(localStart, localEnd, mime));
  }
  return new Blob(parts, { type: mime });
}

export async function deleteChunks(
  transaction: IDBTransaction,
  wait: Wait,
  contentId: string,
): Promise<void> {
  const store = transaction.objectStore(STORE_CHUNKS);
  const keys = await collectChunkKeys(store.index(CHUNK_INDEX.contentId), contentId);
  await Promise.all(keys.map((key) => wait(store.delete(key))));
}

/**
 * Every distinct content id held in the chunk store.
 *
 * Reads index keys only, so it never loads a chunk's bytes. Used by the sweep that
 * removes content no record references.
 */
export function listContentIds(transaction: IDBTransaction): Promise<string[]> {
  const index = transaction.objectStore(STORE_CHUNKS).index(CHUNK_INDEX.contentId);
  return new Promise<string[]>((resolve, reject) => {
    const seen = new Set<string>();
    // A key cursor yields the *index* key, which is the content id. `getAllKeys` on an
    // index yields primary keys instead, which for this store are [contentId, index].
    const request = index.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve([...seen]);
        return;
      }
      seen.add(String(cursor.key));
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Reading content ids failed'));
  });
}

/** Chunks of one content id, ordered by index so reassembly is correct. */
async function readContentChunks(
  transaction: IDBTransaction,
  contentId: string,
): Promise<StoredChunk[]> {
  const index = transaction.objectStore(STORE_CHUNKS).index(CHUNK_INDEX.contentId);
  const rows = await collectFromCursor<StoredChunk>(index, IDBKeyRange.only(contentId), 'next');
  return rows.sort((a, b) => a.index - b.index);
}

function collectChunkKeys(index: IDBIndex, contentId: string): Promise<IDBValidKey[]> {
  return new Promise<IDBValidKey[]>((resolve, reject) => {
    const keys: IDBValidKey[] = [];
    const request = index.openKeyCursor(IDBKeyRange.only(contentId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(keys);
        return;
      }
      keys.push(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Reading chunk keys failed'));
  });
}
