/**
 * Public type surface of `idb-file-store`.
 *
 * The types are grouped as:
 * - records: what you get back ({@link FileRecord}, {@link Page}),
 * - mutations: what you send in ({@link AddOptions}, {@link UpdateOptions}),
 * - queries: how you ask for things ({@link Where}, {@link Sort}, {@link Query}).
 */

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** A JSON-serialisable value, the only thing allowed inside `metadata`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Coarse bucket derived from the MIME type, handy for filtering in a UI. */
export type FileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'code'
  | 'font'
  | 'other';

/** All file kinds, in a stable order. */
export const FILE_KINDS: readonly FileKind[] = [
  'image',
  'video',
  'audio',
  'text',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'code',
  'font',
  'other',
];

/**
 * A file as stored in the database. Contains metadata only, never the bytes,
 * unless you explicitly ask for them with `includeBlob` / `includeText`.
 */
export interface FileRecord {
  /** Stable unique id (`crypto.randomUUID()` unless supplied). */
  id: string;
  /**
   * Key the bytes are stored under. Two records with identical bytes share one
   * `contentId`, and therefore one copy on disk.
   */
  contentId: string;
  /** Display name including the extension, e.g. `holiday-2024.mp4`. */
  name: string;
  /** Coarse category derived from the MIME type. */
  kind: FileKind;
  /** MIME type, e.g. `video/mp4`. */
  mime: string;
  /** Lowercased extension without the dot, e.g. `mp4`. Empty when unknown. */
  extension: string;
  /** Size in bytes. */
  size: number;
  /** Creation time in milliseconds since the epoch. */
  createdAt: number;
  /** Last modification time in milliseconds since the epoch. */
  updatedAt: number;
  /** Last time the bytes were read back, in milliseconds since the epoch. */
  accessedAt: number;
  /** Content hash (SHA-256 hex) when it was computed, otherwise `null`. */
  hash: string | null;
  /** Free-form labels used for filtering. */
  tags: string[];
  /** Virtual folder path, always starts with `/`. Defaults to `/`. */
  folder: string;
  /** Whether the record is starred. */
  favorite: boolean;
  /** Whether the record sits in the trash. */
  deleted: boolean;
  /** When the record was trashed, otherwise `null`. */
  deletedAt: number | null;
  /** User supplied notes, indexed for search. */
  notes: string;
  /** Pixel width for images and video, when known. */
  width: number | null;
  /** Pixel height for images and video, when known. */
  height: number | null;
  /** Duration in milliseconds for audio and video, when known. */
  durationMs: number | null;
  /** Number of stored chunks backing the bytes. */
  chunkCount: number;
  /** Chunk size in bytes used when the file was written. */
  chunkSize: number;
  /** Arbitrary structured data attached by the host application. */
  metadata: Record<string, JsonValue>;
  /** Monotonic counter bumped on every write. */
  revision: number;
  /** Extracted or supplied searchable text. Only present with `includeText`. */
  text?: string;
  /** The bytes. Only present with `includeBlob`. */
  blob?: Blob;
  /** Generated preview image. Only present with `includeThumbnail`. */
  thumbnail?: Blob;
  /** Relevance score. Only present when the query used `search`. */
  score?: number;
}

/** One page of results returned by {@link FileDB.list} and friends. */
export interface Page<T> {
  /** The records for this page. */
  items: T[];
  /** Total number of records matching the query, ignoring `limit`/`offset`. */
  total: number;
  /** Offset this page started at. */
  offset: number;
  /** Maximum number of items this page could hold. */
  limit: number;
  /** `true` when more records exist after this page. */
  hasMore: boolean;
  /**
   * Opaque cursor pointing at the record after this page. Pass it back as
   * `cursor` to fetch the next page without re-scanning everything.
   */
  nextCursor: string | null;
}

/** Aggregate numbers describing what is in the database. */
export interface StorageStats {
  /** Number of live (non-trashed) records. */
  count: number;
  /** Total bytes of live records, counted per record. Sharing can make this exceed what is stored. */
  size: number;
  /** Bytes actually held in the chunk store, including content the trash still holds. */
  physicalSize: number;
  /** `size - physicalSize`, floored at zero: what sharing saves, less any trashed bytes. */
  sharedBytes: number;
  /** Number of trashed records. */
  trashedCount: number;
  /** Total bytes of trashed records. */
  trashedSize: number;
  /** Live count and bytes per {@link FileKind}. */
  byKind: Record<string, { count: number; size: number }>;
  /** Live count and bytes per MIME type. */
  byMime: Record<string, { count: number; size: number }>;
  /** Oldest and newest `createdAt` seen among live records. */
  range: { oldest: number | null; newest: number | null };
  /**
   * Browser reported quota usage when `navigator.storage.estimate()` exists,
   * otherwise `null`.
   */
  quota: { usage: number | null; quota: number | null } | null;
}

/* -------------------------------------------------------------------------- */
/* Mutation options                                                           */
/* -------------------------------------------------------------------------- */

/** Anything the library can turn into stored bytes. */
export type FileInput = Blob | File | ArrayBuffer | ArrayBufferView | string;

/**
 * Fields a caller may set on a record, whether it is being created or changed.
 *
 * {@link AddOptions} and {@link UpdateOptions} both extend this, so an option
 * added here is available at every call site and the two cannot drift apart.
 * `null` clears an optional field.
 */
export interface MutableFileFields {
  /** Display name. Derived from `File.name`, then the MIME type, when omitted. */
  name?: string;
  /** MIME type, overriding detection. */
  mime?: string;
  /** Coarse kind, overriding detection from the MIME type. */
  kind?: FileKind;
  /** Tag list. Replaces the existing tags on an update. */
  tags?: string[];
  /** Virtual folder. Normalised to always start with `/`. */
  folder?: string;
  /** Star or unstar the record. */
  favorite?: boolean;
  /** Notes, indexed for search. */
  notes?: string;
  /** Structured application data. Must survive a JSON round trip. */
  metadata?: Record<string, JsonValue>;
  /** Override modification time. */
  updatedAt?: number | Date;
  /** Known pixel width (images and video), `null` to clear. */
  width?: number | null;
  /** Known pixel height (images and video), `null` to clear. */
  height?: number | null;
  /** Known duration in milliseconds (audio and video), `null` to clear. */
  durationMs?: number | null;
}

/** Options accepted by {@link FileDB.add} and {@link FileDB.addMany}. */
export interface AddOptions extends MutableFileFields {
  /** Explicit id. A random UUID is generated when omitted. */
  id?: string;
  /** Override creation time. */
  createdAt?: number | Date;
  /** Pre-supplied searchable text. Skips text extraction. */
  text?: string;
  /** Extract text from text-like payloads for search. Defaults to the db option. */
  extractText?: boolean;
  /** Generate a preview image for image payloads. Defaults to the db option. */
  generateThumbnail?: boolean;
  /** Chunk size in bytes. Defaults to the db option. */
  chunkSize?: number;
  /** Compute the content hash. Defaults to the db option. */
  computeHash?: boolean;
  /** Return an existing identical record instead of writing a copy. */
  dedupe?: boolean;
  /** Known pixel width, when detection is unavailable. */
  width?: number;
  /** Known pixel height, when detection is unavailable. */
  height?: number;
  /** Known duration in milliseconds, when detection is unavailable. */
  durationMs?: number;
}

/** Options accepted by {@link FileDB.update}. */
export interface UpdateOptions extends MutableFileFields {
  /** Replace the searchable text; `null` clears it. */
  text?: string | null;
  /** Replace the bytes, re-running extraction, hashing and thumbnails. */
  data?: FileInput;
}

/** Options accepted by read helpers such as {@link FileDB.get}. */
export interface ReadOptions {
  /** Attach the bytes to `record.blob`. */
  includeBlob?: boolean;
  /** Attach the extracted text to `record.text`. */
  includeText?: boolean;
  /** Attach the generated preview to `record.thumbnail`. */
  includeThumbnail?: boolean;
  /** Bump `accessedAt`. Defaults to `false`; reads stay read-only unless asked. */
  touch?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Query surface                                                              */
/* -------------------------------------------------------------------------- */

/** Shorthand for "equal to this value, or one of these values". */
export type OneOrMany<T> = T | readonly T[];

/** Text matching operators shared by name-like fields. */
export interface StringOperators {
  /** Exact match (case-insensitive for text fields). */
  eq?: string;
  /** Not equal. */
  ne?: string;
  /** Substring match. */
  contains?: string;
  /** Prefix match. */
  startsWith?: string;
  /** Suffix match. */
  endsWith?: string;
  /** Any of these values. */
  in?: readonly string[];
  /** None of these values. */
  notIn?: readonly string[];
  /** JavaScript regular expression, applied to the raw value. */
  regex?: RegExp;
}

/** Numeric or timestamp matching operators. */
export interface NumberOperators {
  /** Exact match. */
  eq?: number;
  /** Not equal. */
  ne?: number;
  /** Greater than. */
  gt?: number;
  /** Greater than or equal. */
  gte?: number;
  /** Less than. */
  lt?: number;
  /** Less than or equal. */
  lte?: number;
  /** Inclusive range `[min, max]`. */
  between?: readonly [number, number];
}

/** Timestamp filter accepting `Date` objects or epoch milliseconds. */
export type TimeFilter = Date | number | TimeOperators;

/** Operators for timestamp fields, accepting `Date` objects or epoch milliseconds. */
export interface TimeOperators {
  eq?: Date | number;
  ne?: Date | number;
  gt?: Date | number;
  gte?: Date | number;
  lt?: Date | number;
  lte?: Date | number;
  between?: readonly [Date | number, Date | number];
}

/** Tag matching: an array means "has all of these", an object is explicit. */
export type TagFilter =
  | readonly string[]
  | {
      /** Must have every one of these tags. */
      all?: readonly string[];
      /** Must have at least one of these tags. */
      any?: readonly string[];
      /** Must have none of these tags. */
      none?: readonly string[];
    };

/** Folder matching: a string means "exactly this folder". */
export type FolderFilter =
  | string
  | readonly string[]
  | {
      /** Exact folder match. */
      eq?: string;
      /** Folder or any nested folder below it. */
      startsWith?: string;
    };

/** Declarative filter passed as `query.where`. */
export interface Where {
  /** Match specific ids. */
  id?: OneOrMany<string>;
  /** Match on the display name (case-insensitive). */
  name?: OneOrMany<string> | StringOperators;
  /** Match on the coarse kind. */
  kind?: OneOrMany<FileKind>;
  /** Match on the MIME type. */
  mime?: OneOrMany<string> | StringOperators;
  /** Match on the file extension without the dot. */
  extension?: OneOrMany<string> | StringOperators;
  /** Match on size in bytes. */
  size?: NumberOperators;
  /** Match on creation time. */
  createdAt?: TimeFilter;
  /** Match on modification time. */
  updatedAt?: TimeFilter;
  /** Match on last read time. */
  accessedAt?: TimeFilter;
  /** Match on the virtual folder. */
  folder?: FolderFilter;
  /** Match on tags. */
  tags?: TagFilter;
  /** Match starred records. */
  favorite?: boolean;
  /** Match trashed records. Defaults to `false` in every query. */
  deleted?: boolean;
  /** Match on the content hash. */
  hash?: OneOrMany<string>;
  /** Exact match on metadata keys; nested paths use dots (`{ 'exif.iso': 100 }`). */
  metadata?: Record<string, JsonValue>;
  /** Case-insensitive substring match on metadata values, same path syntax. */
  metadataContains?: Record<string, string>;
  /** Escape hatch: arbitrary predicate evaluated against the stored record. */
  custom?: (record: FileRecord) => boolean;
}

/** Fields you can sort by. */
export type SortField =
  | 'name'
  | 'size'
  | 'createdAt'
  | 'updatedAt'
  | 'accessedAt'
  | 'kind'
  | 'mime'
  | 'extension'
  | 'folder'
  | 'favorite'
  | 'revision';

/** A single sort instruction. */
export interface Sort {
  /** Field to order by. */
  by: SortField;
  /** Direction, defaults to `asc`. */
  order?: 'asc' | 'desc';
}

/** How to rank records in a `search` query. */
export interface SearchQuery {
  /** The text to look for. */
  text: string;
  /** Restrict matching to these fields. Defaults to all searchable fields. */
  fields?: readonly SearchField[];
  /** `all` requires every token to match, `any` requires one. Defaults to `all`. */
  mode?: 'all' | 'any';
  /** Allow one-character typos in tokens of four characters or more. Defaults to `false`. */
  fuzzy?: boolean;
  /** Multiplier applied to `score`. Defaults to `1`. */
  boost?: number;
}

/** Fields `search` can look at. */
export type SearchField =
  | 'name'
  | 'text'
  | 'notes'
  | 'tags'
  | 'folder'
  | 'mime'
  | 'metadata';

/** A complete query. Every field is optional; an empty query lists everything. */
export interface Query {
  /** Declarative filter. */
  where?: Where;
  /** Full-text search, or a structured {@link SearchQuery}. */
  search?: string | SearchQuery;
  /** One or more sort instructions. Defaults to `createdAt` descending. */
  sort?: Sort | readonly Sort[];
  /** Maximum number of records to return. Defaults to `100`. */
  limit?: number;
  /** Number of records to skip. Ignored when `cursor` is present. */
  offset?: number;
  /** Cursor from a previous {@link Page}. */
  cursor?: string | null;
  /** Attach `blob` to every item. */
  includeBlob?: boolean;
  /** Attach `text` to every item. */
  includeText?: boolean;
  /** Attach `thumbnail` to every item. */
  includeThumbnail?: boolean;
}

/** Options accepted by {@link FileDB.iterate}. */
export interface IterateOptions {
  /** Filter to apply. */
  where?: Where;
  /** Full-text search to apply. */
  search?: string | SearchQuery;
  /** Optional sort, applied after collection. */
  sort?: Sort | readonly Sort[];
  /** Abort the iteration early by returning `false`. */
  signal?: AbortSignal;
}

/** Options accepted by {@link FileDB.importFiles}. */
export interface ImportOptions extends AddOptions {
  /** Prefix the file name with the relative folder path from a directory upload. */
  preserveRelativePath?: boolean;
  /** Called after each file with the number of files processed so far. */
  onProgress?: (done: number, total: number, record: FileRecord) => void;
}

/** A single entry of {@link FileDB.backup}. */
export interface BackupEntry {
  /** The record metadata. */
  record: FileRecord;
  /** The raw bytes, or `null` when the record no longer has them. */
  blob: Blob | null;
}

/** A portable description of a whole database. */
export interface Backup {
  /** Format version of the backup itself. */
  format: 1;
  /** Database that produced the backup. */
  database: string;
  /** When the backup was taken, in milliseconds since the epoch. */
  createdAt: number;
  /** Every record, with bytes attached. */
  entries: BackupEntry[];
}

/** Options accepted by {@link FileDB.restore}. */
export interface RestoreOptions {
  /** Wipe the existing database first. Defaults to `false`. */
  replace?: boolean;
  /** Called after each entry with the number of entries processed so far. */
  onProgress?: (done: number, total: number) => void;
}

/** The set of events the database emits. */
export interface FileDBEventMap {
  /** A record was created. */
  add: FileRecord;
  /** A record changed. */
  update: FileRecord;
  /** A record was trashed. */
  delete: FileRecord;
  /** A record was permanently removed. */
  purge: FileRecord;
  /** A record was restored from the trash. */
  restore: FileRecord;
  /** Any of the above, useful for cache invalidation. */
  change: FileDBChange;
  /** An `add` was skipped because an identical record already existed. */
  duplicate: FileRecord;
  /** The database was opened. */
  open: { name: string; version: number };
  /** The database was closed. */
  close: { name: string };
  /** The database was deleted from disk. */
  destroy: { name: string };
}

/** Payload of the `change` event. */
export interface FileDBChange {
  /** What happened. */
  type: 'add' | 'update' | 'delete' | 'restore' | 'purge' | 'clear';
  /** The affected record, absent for `clear`. */
  record?: FileRecord;
  /** `true` when the change arrived from another tab. */
  remote: boolean;
}