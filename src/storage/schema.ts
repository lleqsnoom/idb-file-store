/**
 * Database schema and migrations.
 *
 * Version 1 creates four object stores:
 * - `files`: one row per file, metadata only.
 * - `files` indexes: name, kind, mime, extension, size, timestamps, folder,
 *   tags (multi-entry), favorite, trash state and content hash. These indexes let
 *   the query planner hand most filters straight to IndexedDB instead of
 *   scanning every record.
 * - `chunks`: the bytes, split into fixed-size pieces keyed by `[fileId, index]`.
 * - `thumbnails`: generated previews, kept out of `files` so listings stay small.
 * - `meta`: schema bookkeeping and per-database settings.
 */

/** Current schema version. Bump it and add a step in {@link upgradeSchema} to migrate. */
export const SCHEMA_VERSION = 1;

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
} as const;

/** Index names on the `chunks` store. */
export const CHUNK_INDEX = {
  fileId: 'by_file',
} as const;

/**
 * Creates or migrates the schema.
 *
 * Called from `onupgradeneeded`; every step must be additive so that a database
 * created by an older version keeps working.
 *
 * @param db - The database being upgraded.
 * @param oldVersion - Version the database had before this upgrade.
 */
export function upgradeSchema(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    createFilesStore(db);
    createChunksStore(db);
    createThumbnailsStore(db);
    createMetaStore(db);
  }
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
}

function createChunksStore(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE_CHUNKS, { keyPath: ['fileId', 'index'] });
  store.createIndex(CHUNK_INDEX.fileId, 'fileId', { unique: false });
}

function createThumbnailsStore(db: IDBDatabase): void {
  db.createObjectStore(STORE_THUMBS, { keyPath: 'id' });
}

function createMetaStore(db: IDBDatabase): void {
  db.createObjectStore(STORE_META, { keyPath: 'key' });
}