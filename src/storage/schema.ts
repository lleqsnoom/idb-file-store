/**
 * Database schema and migrations.
 *
 * Version 1 creates four object stores:
 * - `files`: one row per file, metadata only. Version 2 adds `contentId` to the row.
 * - `files` indexes: name, kind, mime, extension, size, timestamps, folder,
 *   tags (multi-entry), favorite, trash state and content hash. These indexes let
 *   the query planner hand most filters straight to IndexedDB instead of
 *   scanning every record.
 * - `chunks`: the bytes, split into fixed-size pieces keyed by `[contentId, index]`, so
 *   records sharing identical bytes share one copy. Version 1 keyed this store by
 *   record id; version 2 rekeys it, and version 3 re-runs that rekey for databases
 *   that report version 2 without having had it.
 * - `thumbnails`: generated previews, kept out of `files` so listings stay small.
 * - `meta`: schema bookkeeping and per-database settings.
 */

import type { StoredChunk, StoredFile } from './records.js';

/**
 * Current schema version. Bump it and add a step in {@link upgradeSchema} to migrate.
 *
 * Version 2 keys the chunk store by content id instead of record id, so records with
 * identical bytes reference one copy. Version 3 re-runs that rekey when a database
 * reports version 2 but still holds record-keyed chunks.
 */
export const SCHEMA_VERSION = 3;

/** Object store holding file metadata. */
export const STORE_FILES = 'files';
/** Object store holding file bytes, chunked. */
export const STORE_CHUNKS = 'chunks';
/** Object store holding generated preview images. */
export const STORE_THUMBS = 'thumbnails';
/** Object store holding schema bookkeeping. */
export const STORE_META = 'meta';

/** Every object store in the database. */
export const ALL_STORES: readonly string[] = [STORE_FILES, STORE_CHUNKS, STORE_THUMBS, STORE_META];

/** Index names on the `files` store. */
export const INDEX = {
  name: 'by_name',
  kind: 'by_kind',
  mime: 'by_mime',
  extension: 'by_extension',
  size: 'by_size',
  createdAt: 'by_created',
  updatedAt: 'by_updated',
  accessedAt: 'by_accessed',
  folder: 'by_folder',
  tags: 'by_tags',
  favorite: 'by_favorite',
  deletedAt: 'by_deleted',
  hash: 'by_hash',
  contentId: 'by_content',
} as const;

/** Index names on the `chunks` store. */
export const CHUNK_INDEX = {
  contentId: 'by_content',
} as const;

/**
 * Creates or migrates the schema.
 *
 * Called from `onupgradeneeded`; every step must be additive so that a database created
 * by an older version keeps working.
 *
 * @param db - The database being upgraded.
 * @param oldVersion - Version the database had before this upgrade.
 * @param transaction - The live version-change transaction. Required from version 2 on,
 * because migrating needs to read the data it is rekeying.
 */
export function upgradeSchema(
  db: IDBDatabase,
  oldVersion: number,
  transaction?: IDBTransaction,
): void {
  if (oldVersion < 1) {
    createFilesStore(db);
    createChunksStore(db);
    createThumbnailsStore(db);
    createMetaStore(db);
  }
  if (oldVersion >= 1 && oldVersion < 2) {
    migrateToContentKeys(db, requireTransaction(transaction, 2));
  }
  if (oldVersion >= 2 && oldVersion < 3) {
    // A database can report version 2 and still hold the version 1 chunk layout: an
    // intermediate build raised the number before the rekeying step existed. The
    // version cannot reveal that, the store's shape can, so the rekey runs again when
    // the chunks are not content-keyed.
    const versionChange = requireTransaction(transaction, 3);
    if (needsContentKeys(versionChange)) migrateToContentKeys(db, versionChange);
  }
}

/** The version-change transaction, or an error naming the migration that needs it. */
function requireTransaction(transaction: IDBTransaction | undefined, target: number): IDBTransaction {
  if (!transaction) {
    throw new Error(`Migrating to schema version ${target} needs the version-change transaction`);
  }
  return transaction;
}

/** `true` when the chunk store is not keyed by content, whatever the version says. */
function needsContentKeys(transaction: IDBTransaction): boolean {
  return !transaction.objectStore(STORE_CHUNKS).indexNames.contains(CHUNK_INDEX.contentId);
}

/** Temporary store used while the chunk store is recreated under a new key. */
const STAGING_CHUNKS = 'chunks_staging';

/**
 * Rekeys a database so chunks are addressed by content instead of by record.
 *
 * Runs for version 1 databases, and again for a version 2 database whose chunks are
 * still record-keyed. Rows that already carry a content id pass through unchanged, so
 * re-running it on a partly migrated database is safe.
 *
 * An object store's key path cannot be changed in place, so the rows are staged in a
 * temporary store while the real one is recreated. Both copies stream through cursors,
 * which keeps peak memory at one chunk; the transient cost is that the chunks exist
 * twice on disk. If anything fails, the version-change transaction aborts and the
 * database stays on version 1.
 */
function migrateToContentKeys(db: IDBDatabase, transaction: IDBTransaction): void {
  const files = transaction.objectStore(STORE_FILES);
  if (!files.indexNames.contains(INDEX.contentId)) {
    files.createIndex(INDEX.contentId, 'contentId', { unique: false });
  }

  const contentIdByRecord = new Map<string, string>();
  eachRow(
    files,
    null,
    (cursor) => {
      const row = cursor.value as Pick<StoredFile, 'id' | 'hash'>;
      contentIdByRecord.set(row.id, row.hash ?? row.id);
    },
    () => {
      const staging = db.createObjectStore(STAGING_CHUNKS, {
        keyPath: ['contentId', 'index'],
      });
      staging.createIndex(CHUNK_INDEX.contentId, 'contentId', { unique: false });
      stageChunks(transaction, staging, contentIdByRecord, () =>
        replaceChunkStore(db, transaction),
      );
    },
    () => transaction.abort(),
  );
}

/** Copies chunks into the staging store under their new content keys. */
function stageChunks(
  transaction: IDBTransaction,
  staging: IDBObjectStore,
  contentIdByRecord: Map<string, string>,
  done: () => void,
): void {
  eachRow(
    transaction.objectStore(STORE_CHUNKS),
    null,
    (cursor) => {
      const chunk = cursor.value as StoredChunk & { fileId?: string };
      const recordId = chunk.contentId ?? chunk.fileId ?? '';
      staging.put({
        contentId: contentIdByRecord.get(recordId) ?? recordId,
        index: chunk.index,
        data: chunk.data,
      });
    },
    done,
    () => transaction.abort(),
  );
}

/** Swaps the staging store into place and gives records their content id. */
function replaceChunkStore(db: IDBDatabase, transaction: IDBTransaction): void {
  db.deleteObjectStore(STORE_CHUNKS);
  createChunksStore(db);

  const chunks = transaction.objectStore(STORE_CHUNKS);
  const staging = transaction.objectStore(STAGING_CHUNKS);
  eachRow(
    staging,
    null,
    (cursor) => {
      const row = cursor.value as StoredChunk;
      chunks.put(row);
      staging.delete(cursor.primaryKey);
    },
    () => {
      db.deleteObjectStore(STAGING_CHUNKS);
      rewriteRecords(transaction);
    },
    () => transaction.abort(),
  );
}

/** Gives every record its content id: its hash when it has one, its own id otherwise. */
function rewriteRecords(transaction: IDBTransaction): void {
  const files = transaction.objectStore(STORE_FILES);
  eachRow(
    files,
    null,
    (cursor) => {
      const row = cursor.value as StoredFile;
      files.put({ ...row, contentId: row.hash ?? row.id });
    },
    () => undefined,
    () => transaction.abort(),
  );
}

/**
 * Visits every row of a store through a cursor.
 *
 * Cursors, rather than `getAll`, keep memory bounded to one row. None of the three
 * callbacks may await: issuing requests from the cursor handler is what keeps the
 * version-change transaction alive. `fail` is expected to abort that transaction,
 * which is what leaves a half-migrated database on the version it started on.
 */
function eachRow(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null,
  visit: (cursor: IDBCursorWithValue) => void,
  done: () => void,
  fail: () => void,
): void {
  const request = source.openCursor(query);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      done();
      return;
    }
    try {
      visit(cursor);
    } catch {
      fail();
      return;
    }
    cursor.continue();
  };
  request.onerror = fail;
}

function createFilesStore(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE_FILES, { keyPath: 'id' });
  store.createIndex(INDEX.name, 'nameLower', { unique: false });
  store.createIndex(INDEX.kind, 'kind', { unique: false });
  store.createIndex(INDEX.mime, 'mime', { unique: false });
  store.createIndex(INDEX.extension, 'extension', { unique: false });
  store.createIndex(INDEX.size, 'size', { unique: false });
  store.createIndex(INDEX.createdAt, 'createdAt', { unique: false });
  store.createIndex(INDEX.updatedAt, 'updatedAt', { unique: false });
  store.createIndex(INDEX.accessedAt, 'accessedAt', { unique: false });
  store.createIndex(INDEX.folder, 'folder', { unique: false });
  store.createIndex(INDEX.tags, 'tags', { unique: false, multiEntry: true });
  store.createIndex(INDEX.favorite, 'favorite', { unique: false });
  store.createIndex(INDEX.deletedAt, 'deletedAt', { unique: false });
  store.createIndex(INDEX.hash, 'hash', { unique: false });
  store.createIndex(INDEX.contentId, 'contentId', { unique: false });
}

function createChunksStore(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE_CHUNKS, { keyPath: ['contentId', 'index'] });
  store.createIndex(CHUNK_INDEX.contentId, 'contentId', { unique: false });
}

function createThumbnailsStore(db: IDBDatabase): void {
  db.createObjectStore(STORE_THUMBS, { keyPath: 'id' });
}

function createMetaStore(db: IDBDatabase): void {
  db.createObjectStore(STORE_META, { keyPath: 'key' });
}
