import { NotFoundError, ValidationError } from '../errors.js';
import type { StoredChunk } from './records.js';
import { collectFromCursor, type Wait } from './idb.js';
import { CHUNK_INDEX, STORE_CHUNKS } from './schema.js';

/**
 * Chunked blob storage.
 *
 * Bytes never live in the `files` record. They are sliced into fixed-size pieces
 * and written to the `chunks` store, keyed by `[fileId, index]`. That means:
 * - a multi-gigabyte video is never held in memory as one allocation,
 * - reading a byte range (a video seek, a PDF page) only touches the needed chunks,
 * - deleting a file is a range delete on one index, not a rewrite of the record.
 *
 * Every helper takes the live transaction explicitly, so the caller controls
 * atomicity: writing a record and its chunks always commits or rolls back together.
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

/** Writes the bytes of `blob` as chunks. Resolves with the resulting chunk layout. */
export async function writeChunks(
  transaction: IDBTransaction,
  wait: Wait,
  fileId: string,
  blob: Blob,
  chunkSize: number,
): Promise<{ chunkCount: number; chunkSize: number }> {
  const store = transaction.objectStore(STORE_CHUNKS);
  const total = chunkCountFor(blob.size, chunkSize);
  // Sequential slicing keeps at most `chunkSize` bytes alive at once; the puts
  // themselves are issued in parallel so the transaction commits in one round trip.
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSize;
    const slice = blob.slice(start, Math.min(start + chunkSize, blob.size), blob.type);
    const chunk: StoredChunk = { fileId, index, data: slice };
    pending.push(wait(store.put(chunk)));
  }
  await Promise.all(pending);
  return { chunkCount: total, chunkSize };
}

/** Reads every chunk back and reassembles them into a single blob. */
export async function readChunks(
  transaction: IDBTransaction,
  fileId: string,
  mime: string,
  expectedChunks = 0,
): Promise<Blob> {
  const index = transaction.objectStore(STORE_CHUNKS).index(CHUNK_INDEX.fileId);
  const rows = await collectFromCursor<StoredChunk>(index, IDBKeyRange.only(fileId), 'next');
  if (rows.length === 0) {
    if (expectedChunks > 0) {
      throw new NotFoundError(`Bytes for "${fileId}" are missing from the chunk store`);
    }
    return new Blob([], { type: mime });
  }
  rows.sort((a, b) => a.index - b.index);
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
  fileId: string,
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
    requests.push(wait(store.get([fileId, index]) as IDBRequest<StoredChunk | undefined>));
  }
  const rows = await Promise.all(requests);

  const parts: Blob[] = [];
  for (let offset = 0; offset < rows.length; offset += 1) {
    const row = rows[offset];
    if (!row) throw new NotFoundError(`Chunk ${firstIndex + offset} of "${fileId}" is missing`);
    const chunkStart = (firstIndex + offset) * chunkSize;
    const localStart = Math.max(0, start - chunkStart);
    const localEnd = Math.min(row.data.size, end - chunkStart);
    parts.push(row.data.slice(localStart, localEnd, mime));
  }
  return new Blob(parts, { type: mime });
}

/** Number of chunks currently stored for a file. */
export function countChunks(
  transaction: IDBTransaction,
  wait: Wait,
  fileId: string,
): Promise<number> {
  const index = transaction.objectStore(STORE_CHUNKS).index(CHUNK_INDEX.fileId);
  return wait(index.count(IDBKeyRange.only(fileId)));
}

/** Deletes every chunk belonging to a file. */
export async function deleteChunks(
  transaction: IDBTransaction,
  wait: Wait,
  fileId: string,
): Promise<void> {
  const store = transaction.objectStore(STORE_CHUNKS);
  const index = store.index(CHUNK_INDEX.fileId);
  const keys = await collectChunkKeys(index, fileId);
  await Promise.all(keys.map((key) => wait(store.delete(key))));
}

/** Deletes chunks for many files in one pass, used by bulk delete and trash purge. */
export async function deleteChunksForMany(
  transaction: IDBTransaction,
  wait: Wait,
  fileIds: readonly string[],
): Promise<void> {
  const store = transaction.objectStore(STORE_CHUNKS);
  const index = store.index(CHUNK_INDEX.fileId);
  for (const fileId of fileIds) {
    const keys = await collectChunkKeys(index, fileId);
    await Promise.all(keys.map((key) => wait(store.delete(key))));
  }
}

function collectChunkKeys(index: IDBIndex, fileId: string): Promise<IDBValidKey[]> {
  return new Promise<IDBValidKey[]>((resolve, reject) => {
    const keys: IDBValidKey[] = [];
    const request = index.openKeyCursor(IDBKeyRange.only(fileId));
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