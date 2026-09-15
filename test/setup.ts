// Installs `indexedDB`, `IDBKeyRange`, `IDBTransaction`, ... as globals so the
// library runs unmodified under Node.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { FileDBOptions } from '../src/index.js';
import { FileDB } from '../src/index.js';

let counter = 0;

/**
 * Creates a database backed by a throwaway in-memory IndexedDB factory, so tests
 * never see each other's data and never touch real browser storage.
 */
export function createDb(options: Partial<FileDBOptions> = {}): FileDB {
  counter += 1;
  return new FileDB({
    name: `test-db-${counter}`,
    indexedDB: new IDBFactory() as unknown as IDBFactory,
    syncTabs: false,
    ...options,
  });
}

/** Creates and opens a database. */
export async function openDb(options: Partial<FileDBOptions> = {}): Promise<FileDB> {
  const db = createDb(options);
  await db.open();
  return db;
}

/** A blob of `size` bytes with a repeating printable pattern. */
export function makeBlob(size: number, type = 'application/octet-stream'): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i % 95) + 32;
  return new Blob([bytes], { type });
}

/** Reads a blob as a UTF-8 string. */
export async function textOf(blob: Blob): Promise<string> {
  return blob.text();
}

/** Reads a blob as bytes. */
export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
