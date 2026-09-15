import type { FileKind, JsonValue } from '../types.js';

/**
 * The on-disk shape of a record.
 *
 * It differs from the public {@link FileRecord} in three deliberate ways:
 * - booleans are stored as `0 | 1`, because IndexedDB cannot index booleans,
 * - `deletedAt` uses `0` for "live" so the field is always indexable,
 * - `nameLower` and `searchText` are denormalised to make sorting and searching
 *   cheap, since IndexedDB cannot sort case-insensitively on its own.
 */

/** Internal record stored in the `files` object store. */
export interface StoredFile {
  id: string;
  name: string;
  nameLower: string;
  kind: FileKind;
  mime: string;
  extension: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  accessedAt: number;
  hash: string | null;
  tags: string[];
  folder: string;
  favorite: 0 | 1;
  deletedAt: number;
  notes: string;
  text: string;
  notesLower: string;
  textLower: string;
  tagsLower: string;
  metaText: string;
  searchText: string;
  searchTokens: string[];
  width: number | null;
  height: number | null;
  durationMs: number | null;
  chunkCount: number;
  chunkSize: number;
  metadata: Record<string, JsonValue>;
  revision: number;
}

/** A chunk of file bytes. Keyed by `[fileId, index]`. */
export interface StoredChunk {
  fileId: string;
  index: number;
  data: Blob;
}

/** A generated preview image. */
export interface StoredThumbnail {
  id: string;
  blob: Blob;
  width: number;
  height: number;
  createdAt: number;
}

/** A key/value row in the `meta` store, used for migration bookkeeping. */
export interface StoredMeta {
  key: string;
  value: JsonValue;
}