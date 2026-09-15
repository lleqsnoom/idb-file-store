/**
 * idb-file-store
 *
 * A queryable, local-first file database for the browser, built on IndexedDB.
 * Store, search, filter, sort and manage images, video, audio, documents and any
 * other user files without a server.
 *
 * ```ts
 * import { FileDB } from 'idb-file-store';
 *
 * const db = new FileDB({ name: 'my-vault' });
 * await db.open();
 *
 * await db.add(file, { tags: ['holiday'], folder: '/photos/2024' });
 *
 * const page = await db.list({
 *   where: { kind: 'image', size: { gte: 1024 } },
 *   search: 'beach',
 *   sort: { by: 'createdAt', order: 'desc' },
 *   limit: 24,
 * });
 * ```
 *
 * @packageDocumentation
 */

export { FileDB } from './file-db.js';
export type { FileDBOptions, Facets, Snapshot } from './file-db.js';

export {
  ClosedError,
  FileDBError,
  NotFoundError,
  NotSupportedError,
  QuotaError,
  ValidationError,
} from './errors.js';

export { FILE_KINDS } from './types.js';
export type {
  AddOptions,
  Backup,
  BackupEntry,
  FileDBChange,
  FileDBEventMap,
  FileInput,
  FileKind,
  FileRecord,
  FolderFilter,
  ImportOptions,
  IterateOptions,
  JsonValue,
  NumberOperators,
  OneOrMany,
  Page,
  Query,
  ReadOptions,
  RestoreOptions,
  SearchField,
  SearchQuery,
  Sort,
  SortField,
  StorageStats,
  StringOperators,
  TagFilter,
  TimeFilter,
  TimeOperators,
  UpdateOptions,
  Where,
} from './types.js';

export type { StorageStats as FileDBStats } from './types.js';

export type { CursorPayload } from './query/cursor.js';
export { decodeCursor, encodeCursor } from './query/cursor.js';
export { DEFAULT_SEARCH_FIELDS, resolveSearch, scoreRecord } from './query/search.js';
export { DEFAULT_LIMIT } from './query/select.js';
export { planIndex } from './query/plan.js';
export type { IndexPlan } from './query/plan.js';
export { DEFAULT_CHUNK_SIZE, normalizeChunkSize } from './storage/chunk-store.js';

export {
  DEFAULT_THUMBNAIL_SIZE,
  fitWithin,
  generateThumbnail,
  readImageDimensions,
  supportsImageDecoding,
} from './utils/thumbnail.js';
export type { ImageDimensions, ThumbnailOptions, ThumbnailResult } from './utils/thumbnail.js';

export { contentHash, supportsWebCrypto } from './utils/hash.js';
export {
  extensionFromMime,
  extensionOf,
  isTextLikeMime,
  kindFromMime,
  mimeFromName,
  normalizeMime,
} from './utils/mime.js';
export { formatBytes } from './utils/misc.js';
export { isInsideFolder, normalizeFolder } from './utils/path.js';
export { boundedLevenshtein, normalizeText, tokenize } from './utils/text.js';
export { toBlob } from './utils/misc.js';

export { Emitter } from './events.js';
export type { Listener, Unsubscribe } from './events.js';
