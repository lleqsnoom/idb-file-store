import {
  ClosedError,
  FileDBError,
  NotFoundError,
  NotSupportedError,
  ValidationError,
  wrapIdbError,
} from './errors.js';
import { Emitter, type Listener, type Unsubscribe } from './events.js';
import {
  ALL_STORES,
  CHUNK_INDEX,
  SCHEMA_VERSION,
  STORE_CHUNKS,
  STORE_FILES,
  STORE_META,
  STORE_THUMBS,
  upgradeSchema,
} from './storage/schema.js';
import {
  deleteChunks,
  deleteChunksForMany,
  readChunkRange,
  readChunks,
  writeChunks,
} from './storage/chunk-store.js';
import {
  deleteDatabase,
  openDatabase,
  runTransaction,
  waitForRequest,
  waitForTransaction,
  type Wait,
} from './storage/idb.js';
import type { StoredFile, StoredThumbnail } from './storage/records.js';
import { prepareWrite, type PreparedWrite } from './storage/prepare.js';
import { planIndex, type IndexPlan } from './query/plan.js';
import { matchesRecord } from './query/match.js';
import { countRecords, selectRecords, type Selection } from './query/select.js';
import { resolveSearch, scoreRecord } from './query/search.js';
import { INDEX } from './storage/schema.js';
import type {
  AddOptions,
  Backup,
  BackupEntry,
  FileDBChange,
  FileDBEventMap,
  FileInput,
  FileRecord,
  ImportOptions,
  IterateOptions,
  Page,
  Query,
  ReadOptions,
  RestoreOptions,
  StorageStats,
  UpdateOptions,
  Where,
} from './types.js';
import {
  buildSearchColumns,
  normalizeName,
  normalizeTags,
  prepareFolder,
  prepareMetadata,
  resolveReadOptions,
  toPublicRecord,
} from './utils/record.js';
import { extensionOf, normalizeMime } from './utils/mime.js';
import { createId, inputName, now, toTimestamp } from './utils/misc.js';
import { normalizeMetadata } from './utils/path.js';
import { DEFAULT_THUMBNAIL_SIZE } from './utils/thumbnail.js';

/** Construction options for {@link FileDB}. */
export interface FileDBOptions {
  /**
   * Database name. Two instances with different names are fully independent,
   * which is how you keep, say, a "documents" vault apart from a "media" vault.
   * Defaults to `idb-file-store`.
   */
  name?: string;
  /** Schema version. Defaults to the current schema; only raise it to migrate. */
  version?: number;
  /** Bytes per chunk when writing to disk. Defaults to 2 MiB. */
  chunkSize?: number;
  /** Extract text from text-like payloads for search. Defaults to `true`. */
  extractText?: boolean;
  /** Cap on extracted text, in bytes. Defaults to 256 KiB. */
  maxTextBytes?: number;
  /** Generate preview images for images. Defaults to `true`. */
  generateThumbnails?: boolean;
  /** Longest edge of a generated preview, in pixels. Defaults to 256. */
  thumbnailMaxSize?: number;
  /** Compute a content hash on write. Defaults to `true`. */
  computeHash?: boolean;
  /** Skip hashing above this size, in bytes. Defaults to 64 MiB. */
  hashMaxBytes?: number;
  /** Return an existing record when an identical payload is added. Defaults to `false`. */
  dedupe?: boolean;
  /** Mirror changes to other tabs through `BroadcastChannel`. Defaults to `true`. */
  syncTabs?: boolean;
  /** IndexedDB factory to use. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

/** Resolved options with every default filled in. */
type ResolvedOptions = Required<Omit<FileDBOptions, 'indexedDB'>> & {
  indexedDB: IDBFactory | undefined;
};

/** Aggregate counts describing the shape of a result set, for building filter UIs. */
export interface Facets {
  /** Number of matching live records. */
  count: number;
  /** Total bytes of matching live records. */
  size: number;
  /** Smallest and largest matching size in bytes. */
  sizeRange: { min: number | null; max: number | null };
  /** Oldest and newest matching `createdAt`. */
  dateRange: { oldest: number | null; newest: number | null };
  /** Record count per file kind (`image`, `video`, ...). */
  byKind: Record<string, number>;
  /** Record count per file extension. */
  byExtension: Record<string, number>;
  /** Record count per tag, counting a record once per tag it carries. */
  byTag: Record<string, number>;
  /** Record count per folder. */
  byFolder: Record<string, number>;
}

/** A metadata-only export of a whole database. */
export interface Snapshot {
  /** Format version. */
  format: 1;
  /** Database the snapshot came from. */
  database: string;
  /** When the snapshot was taken, in milliseconds since the epoch. */
  createdAt: number;
  /** Every record, without bytes. */
  records: FileRecord[];
}

const DEFAULTS: ResolvedOptions = {
  name: 'idb-file-store',
  version: SCHEMA_VERSION,
  chunkSize: 2 * 1024 * 1024,
  extractText: true,
  maxTextBytes: 256 * 1024,
  generateThumbnails: true,
  thumbnailMaxSize: DEFAULT_THUMBNAIL_SIZE,
  computeHash: true,
  hashMaxBytes: 64 * 1024 * 1024,
  dedupe: false,
  syncTabs: true,
  indexedDB: undefined,
};

const STREAM_BATCH = 250;

/**
 * A local, queryable file database backed by IndexedDB.
 *
 * ```ts
 * const db = new FileDB({ name: 'my-vault' });
 * await db.open();
 *
 * const record = await db.add(file, { tags: ['holiday'], folder: '/photos/2024' });
 * const page = await db.list({
 *   where: { kind: 'image', size: { gte: 1024 } },
 *   search: 'beach',
 *   sort: { by: 'createdAt', order: 'desc' },
 *   limit: 24,
 * });
 * ```
 *
 * The instance holds one IndexedDB connection and one `BroadcastChannel`. Create
 * one per database name and share it; call {@link FileDB.close} on teardown.
 */
export class FileDB {
  readonly #options: ResolvedOptions;
  readonly #emitter = new Emitter<FileDBEventMap>();
  readonly #instanceId = createId();
  #db: IDBDatabase | null = null;
  #channel: BroadcastChannel | null = null;
  #opening: Promise<this> | null = null;

  constructor(options: FileDBOptions = {}) {
    this.#options = { ...DEFAULTS, ...stripUndefined(options) };
  }

  /** Opens a database and resolves with the ready instance. */
  static async open(options: FileDBOptions = {}): Promise<FileDB> {
    const db = new FileDB(options);
    await db.open();
    return db;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  get name(): string {
    return this.#options.name;
  }

  get version(): number {
    return this.#options.version;
  }

  get isOpen(): boolean {
    return this.#db !== null;
  }

  /** Opens the connection, running migrations when needed. Idempotent. */
  async open(): Promise<this> {
    if (this.#db) return this;
    this.#opening ??= this.#doOpen().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #doOpen(): Promise<this> {
    const db = await openDatabase({
      name: this.#options.name,
      version: this.#options.version,
      factory: this.#options.indexedDB,
      upgrade: (target, oldVersion) => upgradeSchema(target, oldVersion),
      onVersionChange: () => {
        this.#db = null;
      },
    });
    db.onclose = () => {
      this.#db = null;
    };
    this.#db = db;
    this.#connectChannel();
    this.#emitter.emit('open', { name: this.#options.name, version: this.#options.version });
    return this;
  }

  /** Closes the connection. Pending transactions finish first. */
  close(): void {
    this.#channel?.close();
    this.#channel = null;
    if (this.#db) {
      this.#db.close();
      this.#db = null;
      this.#emitter.emit('close', { name: this.#options.name });
    }
  }

  /** Closes the connection and deletes the whole database from disk. */
  async destroy(): Promise<void> {
    this.close();
    await deleteDatabase(this.#options.name, this.#options.indexedDB);
    this.#emitter.emit('destroy', { name: this.#options.name });
  }

  /** The returned function unsubscribes the listener. */
  on<K extends keyof FileDBEventMap>(event: K, listener: Listener<FileDBEventMap[K]>): Unsubscribe {
    return this.#emitter.on(event, listener);
  }

  once<K extends keyof FileDBEventMap>(
    event: K,
    listener: Listener<FileDBEventMap[K]>,
  ): Unsubscribe {
    return this.#emitter.once(event, listener);
  }

  /** Removes one listener, or all listeners for an event. */
  off<K extends keyof FileDBEventMap>(event: K, listener?: Listener<FileDBEventMap[K]>): void {
    this.#emitter.off(event, listener);
  }

  /**
   * Runs `body` inside a transaction, letting you compose several operations
   * atomically. Only IndexedDB requests issued through `wait` may be awaited.
   */
  async transaction<T>(
    stores: string | readonly string[],
    mode: IDBTransactionMode,
    body: (transaction: IDBTransaction, wait: Wait) => T | Promise<T>,
  ): Promise<T> {
    const db = this.#requireDb();
    try {
      return await runTransaction(db, stores, mode, body);
    } catch (error) {
      throw wrapIdbError(error, 'Transaction failed');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Create                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Stores a new file and returns its record. */
  async add(input: FileInput, options: AddOptions = {}): Promise<FileRecord> {
    const id = options.id ?? createId();
    const prepared = await prepareWrite(input, options, id, this.#options);

    if (prepared.row.hash && (options.dedupe ?? this.#options.dedupe)) {
      const existing = await this.#findByHash(prepared.row.hash);
      if (existing) {
        this.#emitter.emit('duplicate', existing);
        return existing;
      }
    }

    const row: StoredFile = {
      id,
      ...prepared.row,
      chunkCount: 0,
      chunkSize: prepared.chunkSize,
    };

    await this.transaction(
      [STORE_FILES, STORE_CHUNKS, STORE_THUMBS],
      'readwrite',
      async (tx, wait) => {
        const store = tx.objectStore(STORE_FILES);
        const clash = await wait(store.get(row.id) as IDBRequest<StoredFile | undefined>);
        if (clash) throw new ValidationError(`A record with id "${row.id}" already exists`);

        const layout = await writeChunks(tx, wait, row.id, prepared.blob, prepared.chunkSize);
        row.chunkCount = layout.chunkCount;
        await wait(store.put(row));
        if (prepared.thumbnail) {
          await wait(tx.objectStore(STORE_THUMBS).put(prepared.thumbnail));
        }
      },
    );

    const record = toPublicRecord(row);
    this.#emit('add', record);
    return record;
  }

  /** Stores many files, one transaction each, reporting progress as it goes. */
  async addMany(
    inputs: readonly FileInput[] | FileList,
    options: ImportOptions = {},
  ): Promise<FileRecord[]> {
    const list = Array.from(inputs as ArrayLike<FileInput>);
    const out: FileRecord[] = [];
    for (const [index, input] of list.entries()) {
      const itemOptions: AddOptions = { ...options };
      const relative = isFile(input) ? (input as { webkitRelativePath?: string }).webkitRelativePath : '';
      if (options.preserveRelativePath && relative) {
        itemOptions.folder = prepareFolder(`${options.folder ?? '/'}/${dirnameOf(relative)}`);
        itemOptions.name ??= inputName(input) ?? undefined;
      }
      const record = await this.add(input, itemOptions);
      out.push(record);
      options.onProgress?.(index + 1, list.length, record);
    }
    return out;
  }

  /** Stores a browser `FileList`, folder structure optional. */
  async importFiles(files: FileList | readonly File[], options: ImportOptions = {}): Promise<FileRecord[]> {
    return this.addMany(files, options);
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                   */
  /* ---------------------------------------------------------------------- */

  /** Reads one record by id. Throws {@link NotFoundError} when missing. */
  async get(id: string, options: ReadOptions = {}): Promise<FileRecord> {
    const record = await this.#getOrNull(id, options);
    if (!record) throw new NotFoundError(`No file with id "${id}"`);
    return record;
  }

  /** Reads one record by id, returning `null` instead of throwing. */
  async find(id: string, options: ReadOptions = {}): Promise<FileRecord | null> {
    return this.#getOrNull(id, options);
  }

  /** `true` when a live record with this id exists. */
  async has(id: string): Promise<boolean> {
    this.#assertOpen();
    return this.transaction(STORE_FILES, 'readonly', async (tx, wait) => {
      const row = await wait(tx.objectStore(STORE_FILES).get(id) as IDBRequest<StoredFile | undefined>);
      return row !== undefined && row.deletedAt === 0;
    });
  }

  /** Reads the raw bytes of a file. */
  async getBlob(id: string): Promise<Blob> {
    this.#assertOpen();
    return this.transaction([STORE_FILES, STORE_CHUNKS], 'readonly', async (tx, wait) => {
      const row = await this.#requireRow(tx, wait, id);
      return readChunks(tx, id, row.mime, row.chunkCount);
    });
  }

  /** Reads a byte range, touching only the chunks that overlap it. */
  async readRange(id: string, start: number, end: number): Promise<Blob> {
    this.#assertOpen();
    return this.transaction([STORE_FILES, STORE_CHUNKS], 'readonly', async (tx, wait) => {
      const row = await this.#requireRow(tx, wait, id);
      return readChunkRange(tx, wait, id, start, end, row.mime, row.chunkSize);
    });
  }

  /** Reads the extracted text of a file, or an empty string when there is none. */
  async getText(id: string): Promise<string> {
    this.#assertOpen();
    return this.transaction(STORE_FILES, 'readonly', async (tx, wait) => {
      const row = await this.#requireRow(tx, wait, id);
      return row.text;
    });
  }

  /** Reads the generated preview image, when one exists. */
  async getThumbnail(id: string): Promise<Blob | null> {
    this.#assertOpen();
    return this.transaction([STORE_FILES, STORE_THUMBS], 'readonly', async (tx, wait) => {
      await this.#requireRow(tx, wait, id);
      const row = await wait(
        tx.objectStore(STORE_THUMBS).get(id) as IDBRequest<StoredThumbnail | undefined>,
      );
      return row?.blob ?? null;
    });
  }

  /**
   * Creates an object URL for a file. Remember to call
   * {@link FileDB.revokeObjectURL} when the consumer is unmounted.
   */
  async getObjectURL(id: string): Promise<string> {
    const scope = globalThis as { URL?: typeof URL };
    if (typeof scope.URL?.createObjectURL !== 'function') {
      throw new NotSupportedError('URL.createObjectURL is not available in this environment');
    }
    const blob = await this.getBlob(id);
    return scope.URL.createObjectURL(blob);
  }

  /** Releases an object URL created by {@link FileDB.getObjectURL}. */
  revokeObjectURL(url: string): void {
    const scope = globalThis as { URL?: typeof URL };
    scope.URL?.revokeObjectURL?.(url);
  }

  /** Triggers a browser download of a stored file. No-op outside a DOM. */
  async download(id: string, filename?: string): Promise<void> {
    const scope = globalThis as { document?: Document; URL?: typeof URL };
    if (!scope.document || typeof scope.URL?.createObjectURL !== 'function') {
      throw new NotSupportedError('download() needs a DOM; in a worker, use getBlob() instead');
    }
    const record = await this.get(id);
    const blob = await this.getBlob(id);
    const url = scope.URL.createObjectURL(blob);
    try {
      const anchor = scope.document.createElement('a');
      anchor.href = url;
      anchor.download = filename ?? record.name;
      anchor.rel = 'noopener';
      scope.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      setTimeout(() => this.revokeObjectURL(url), 0);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Update                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Applies a partial change to one record. */
  async update(id: string, options: UpdateOptions = {}): Promise<FileRecord> {
    let replacement: PreparedWrite | null = null;
    if (options.data) {
      // Reading the current row first lets a payload-only update inherit the
      // record's name and MIME type instead of guessing them from scratch.
      const current = await this.get(id);
      const declaredMime =
        options.mime || (options.data instanceof Blob ? options.data.type : '');
      replacement = await prepareWrite(
        options.data,
        { ...options, name: options.name ?? current.name, mime: declaredMime || current.mime },
        id,
        this.#options,
      );
    }
    const thumbnail = replacement?.thumbnail ?? null;

    const updated = await this.transaction(
      [STORE_FILES, STORE_CHUNKS, STORE_THUMBS],
      'readwrite',
      async (tx, wait) => {
        const store = tx.objectStore(STORE_FILES);
        const row = await this.#requireRow(tx, wait, id);
        const next: StoredFile = { ...row };

        if (replacement) {
          await deleteChunks(tx, wait, id);
          const layout = await writeChunks(tx, wait, id, replacement.blob, replacement.chunkSize);
          next.chunkCount = layout.chunkCount;
          next.chunkSize = layout.chunkSize;
          next.size = replacement.blob.size;
          next.mime = replacement.row.mime;
          next.extension = replacement.row.extension;
          next.kind = replacement.row.kind;
          next.hash = replacement.row.hash;
          next.text = replacement.row.text;
          next.textLower = replacement.row.textLower;
          next.width = replacement.row.width;
          next.height = replacement.row.height;
          next.durationMs = replacement.row.durationMs;
          const thumbs = tx.objectStore(STORE_THUMBS);
          if (thumbnail) await wait(thumbs.put(thumbnail));
          else await wait(thumbs.delete(id));
        }

        applyUpdateOptions(next, options);

        next.revision = row.revision + 1;
        next.updatedAt = toTimestamp(options.updatedAt) ?? now();
        refreshSearchColumns(next);

        await wait(store.put(next));
        return next;
      },
    );

    const record = toPublicRecord(updated);
    this.#emit('update', record);
    return record;
  }

  /** Applies the same change to many records. Missing ids are skipped. */
  async updateMany(ids: readonly string[], options: UpdateOptions = {}): Promise<FileRecord[]> {
    const out: FileRecord[] = [];
    for (const id of ids) {
      const record = await this.#updateOrNull(id, options);
      if (record) out.push(record);
    }
    return out;
  }

  /** Adds and removes tags on one record without replacing the whole list. */
  async setTags(
    id: string,
    change: { add?: readonly string[]; remove?: readonly string[] },
  ): Promise<FileRecord> {
    const remove = new Set(normalizeTags(change.remove).map((tag) => tag.toLowerCase()));
    const record = await this.#patch(id, (row) => {
      const kept = row.tags.filter((tag) => !remove.has(tag.toLowerCase()));
      row.tags = normalizeTags([...kept, ...(change.add ?? [])]);
      refreshSearchColumns(row);
      return true;
    });
    if (!record) throw new NotFoundError(`No file with id "${id}"`);
    this.#emitter.emit('update', record);
    this.#emitter.emit('change', { type: 'update', record, remote: false });
    this.#post('update', record);
    return record;
  }

  /** Moves records into a folder. */
  async move(ids: readonly string[], folder: string): Promise<FileRecord[]> {
    return this.updateMany(ids, { folder: prepareFolder(folder) });
  }

  /** Stars or unstars records. */
  async setFavorite(ids: readonly string[], favorite: boolean): Promise<FileRecord[]> {
    return this.updateMany(ids, { favorite });
  }

  /* ---------------------------------------------------------------------- */
  /* Delete                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Moves records to the trash. Recoverable with {@link FileDB.restore}. */
  async trash(ids: readonly string[]): Promise<FileRecord[]> {
    const out: FileRecord[] = [];
    for (const id of ids) {
      const record = await this.#patch(id, (row) => {
        row.deletedAt = now();
        return true;
      });
      if (record) {
        out.push(record);
        this.#emit('delete', record);
      }
    }
    return out;
  }

  /** Brings records back from the trash. */
  async restore(ids: readonly string[]): Promise<FileRecord[]> {
    const out: FileRecord[] = [];
    for (const id of ids) {
      const record = await this.#patch(id, (row) => {
        row.deletedAt = 0;
        return true;
      });
      if (record) {
        out.push(record);
        this.#emit('restore', record);
      }
    }
    return out;
  }

  /** Permanently removes records, their bytes and their previews. */
  async purge(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    this.#assertOpen();
    const removed = await this.transaction(
      [STORE_FILES, STORE_CHUNKS, STORE_THUMBS],
      'readwrite',
      async (tx, wait) => {
        const store = tx.objectStore(STORE_FILES);
        const thumbs = tx.objectStore(STORE_THUMBS);
        const found: StoredFile[] = [];
        for (const id of ids) {
          const row = await wait(store.get(id) as IDBRequest<StoredFile | undefined>);
          if (row) found.push(row);
        }
        await deleteChunksForMany(tx, wait, found.map((row) => row.id));
        for (const row of found) {
          await wait(store.delete(row.id));
          await wait(thumbs.delete(row.id));
        }
        return found;
      },
    );

    for (const row of removed) this.#emit('purge', toPublicRecord(row));
    return removed.length;
  }

  /** Permanently removes everything currently in the trash. */
  async emptyTrash(): Promise<number> {
    const rows = await this.#allRows();
    const ids = rows.filter((row) => row.deletedAt > 0).map((row) => row.id);
    return this.purge(ids);
  }

  /** Empties every store. The database itself stays in place. */
  async clear(): Promise<void> {
    await this.transaction([...ALL_STORES], 'readwrite', async (tx, wait) => {
      for (const name of ALL_STORES) {
        await wait(tx.objectStore(name).clear());
      }
    });
    this.#emitter.emit('change', { type: 'clear', remote: false } satisfies FileDBChange);
    this.#post('clear', null);
  }

  /** Deletes chunk and thumbnail rows that no longer belong to a record. */
  async pruneOrphans(): Promise<number> {
    return this.transaction(
      [STORE_FILES, STORE_CHUNKS, STORE_THUMBS],
      'readwrite',
      async (tx, wait) => {
        const store = tx.objectStore(STORE_FILES);
        const live = new Set(
          (await collectAll<StoredFile>(store, null)).map((row) => row.id),
        );
        let removed = 0;

        const chunks = tx.objectStore(STORE_CHUNKS);
        const chunkKeys = await collectKeys(chunks, null);
        for (const key of chunkKeys) {
          const fileId = Array.isArray(key) ? (key[0] as string) : (key as string);
          if (!live.has(fileId)) {
            await wait(chunks.delete(key));
            removed += 1;
          }
        }

        const thumbs = tx.objectStore(STORE_THUMBS);
        const thumbKeys = await collectKeys(thumbs, null);
        for (const key of thumbKeys) {
          if (!live.has(key as string)) {
            await wait(thumbs.delete(key));
            removed += 1;
          }
        }
        return removed;
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Query                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Lists records matching a query, with filtering, search, sorting and paging. */
  async list(query: Query = {}): Promise<Page<FileRecord>> {
    const candidates = await this.#candidates(query.where);
    const selection = selectRecords(candidates, query);
    const items = await this.#materialize(selection, query);
    return {
      items,
      total: selection.total,
      offset: query.offset ?? 0,
      limit: selection.limit,
      hasMore: selection.nextCursor !== null,
      nextCursor: selection.nextCursor,
    };
  }

  /** Lists every matching record, ignoring `limit`. Handy for exports and stats. */
  async all(query: Query = {}): Promise<FileRecord[]> {
    const page = await this.list({ ...query, limit: Number.POSITIVE_INFINITY, offset: 0, cursor: null });
    return page.items;
  }

  /** Number of records matching a query. */
  async count(query: Query = {}): Promise<number> {
    const candidates = await this.#candidates(query.where);
    return countRecords(candidates, query);
  }

  /** The first matching record, or `null`. */
  async first(query: Query = {}): Promise<FileRecord | null> {
    const page = await this.list({ ...query, limit: 1, offset: 0, cursor: null });
    return page.items[0] ?? null;
  }

  /** Convenience wrapper that runs a text search. */
  async search(text: string, query: Query = {}): Promise<Page<FileRecord>> {
    return this.list({ ...query, search: text });
  }

  /**
   * Streams matching records without collecting them all in memory.
   *
   * When `sort` is set the records are collected first, because ordering cannot
   * be streamed; without it, keys are read up front and records arrive in
   * batches of {@link STREAM_BATCH}.
   */
  async *iterate(options: IterateOptions = {}): AsyncGenerator<FileRecord, void, undefined> {
    if (options.sort) {
      const page = await this.list({
        where: options.where,
        search: options.search,
        sort: options.sort,
        limit: Number.POSITIVE_INFINITY,
        offset: 0,
        cursor: null,
      });
      for (const item of page.items) {
        if (options.signal?.aborted) return;
        yield item;
      }
      return;
    }

    const search = resolveSearch(options.search);
    const keys = await this.#collectKeys(options.where);
    for (let index = 0; index < keys.length; index += STREAM_BATCH) {
      if (options.signal?.aborted) return;
      const batch = keys.slice(index, index + STREAM_BATCH);
      const rows = await this.#getManyRows(batch);
      for (const row of rows) {
        if (!matchesRecord(row, options.where)) continue;
        if (search && scoreRecord(row, search) === null) continue;
        yield toPublicRecord(row);
      }
    }
  }

  /** Aggregates a result set into counts and ranges, for building filter panes. */
  async facets(query: Query = {}): Promise<Facets> {
    const where: Where = { ...query.where, deleted: query.where?.deleted ?? false };
    const candidates = await this.#candidates(where);
    const search = resolveSearch(query.search);

    const facets: Facets = {
      count: 0,
      size: 0,
      sizeRange: { min: null, max: null },
      dateRange: { oldest: null, newest: null },
      byKind: {},
      byExtension: {},
      byTag: {},
      byFolder: {},
    };

    for (const row of candidates) {
      if (!matchesRecord(row, where)) continue;
      if (search && scoreRecord(row, search) === null) continue;

      facets.count += 1;
      facets.size += row.size;
      facets.sizeRange.min =
        facets.sizeRange.min === null ? row.size : Math.min(facets.sizeRange.min, row.size);
      facets.sizeRange.max =
        facets.sizeRange.max === null ? row.size : Math.max(facets.sizeRange.max, row.size);
      facets.dateRange.oldest =
        facets.dateRange.oldest === null
          ? row.createdAt
          : Math.min(facets.dateRange.oldest, row.createdAt);
      facets.dateRange.newest =
        facets.dateRange.newest === null
          ? row.createdAt
          : Math.max(facets.dateRange.newest, row.createdAt);

      bump(facets.byKind, row.kind);
      bump(facets.byExtension, row.extension || '(none)');
      bump(facets.byFolder, row.folder);
      for (const tag of row.tags) bump(facets.byTag, tag);
    }
    return facets;
  }

  /** Totals per kind, per MIME type, trash size and browser quota. */
  async stats(): Promise<StorageStats> {
    this.#assertOpen();
    const rows = await this.transaction(STORE_FILES, 'readonly', async (tx) =>
      collectAll<StoredFile>(tx.objectStore(STORE_FILES), null),
    );

    const byKind: Record<string, { count: number; size: number }> = {};
    const byMime: Record<string, { count: number; size: number }> = {};
    let count = 0;
    let size = 0;
    let trashedCount = 0;
    let trashedSize = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const row of rows) {
      if (row.deletedAt > 0) {
        trashedCount += 1;
        trashedSize += row.size;
        continue;
      }
      count += 1;
      size += row.size;
      bumpSize(byKind, row.kind, row.size);
      bumpSize(byMime, row.mime, row.size);
      oldest = oldest === null ? row.createdAt : Math.min(oldest, row.createdAt);
      newest = newest === null ? row.createdAt : Math.max(newest, row.createdAt);
    }

    return {
      count,
      size,
      trashedCount,
      trashedSize,
      byKind,
      byMime,
      range: { oldest, newest },
      quota: await readQuota(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Backup and restore                                                     */
  /* ---------------------------------------------------------------------- */

  /** Metadata-only export, safe to `JSON.stringify`. */
  async snapshot(): Promise<Snapshot> {
    const rows = await this.#allRows();
    return {
      format: 1,
      database: this.#options.name,
      createdAt: now(),
      records: rows.map((row) => toPublicRecord(row, { text: row.text })),
    };
  }

  /**
   * Reads every record together with its bytes.
   *
   * This holds the whole database in memory, so prefer it for user-driven
   * "download a backup" flows rather than scheduled jobs. Generated previews are
   * not included; they are derived data and can be rebuilt with `pruneOrphans()`
   * plus a re-add, or simply regenerated on demand.
   */
  async backup(): Promise<Backup> {
    const rows = await this.#allRows();
    const entries = await this.transaction(
      [STORE_FILES, STORE_CHUNKS],
      'readonly',
      async (tx) => {
        const out: BackupEntry[] = [];
        for (const row of rows) {
          out.push({
            record: toPublicRecord(row, { text: row.text }),
            blob: await readChunks(tx, row.id, row.mime, row.chunkCount),
          });
        }
        return out;
      },
    );
    return { format: 1, database: this.#options.name, createdAt: now(), entries };
  }

  /** Writes a {@link Backup} back into the database. */
  async restoreBackup(backup: Backup, options: RestoreOptions = {}): Promise<number> {
    if (backup.format !== 1) {
      throw new ValidationError(`Unsupported backup format ${String(backup.format)}`);
    }
    if (options.replace) await this.clear();

    let done = 0;
    for (const entry of backup.entries) {
      const addOptions: AddOptions = {
        id: entry.record.id,
        name: entry.record.name,
        mime: entry.record.mime,
        kind: entry.record.kind,
        tags: entry.record.tags,
        folder: entry.record.folder,
        favorite: entry.record.favorite,
        notes: entry.record.notes,
        metadata: normalizeMetadata(entry.record.metadata as Record<string, unknown>),
        createdAt: entry.record.createdAt,
        updatedAt: entry.record.updatedAt,
        width: entry.record.width ?? undefined,
        height: entry.record.height ?? undefined,
        durationMs: entry.record.durationMs ?? undefined,
        computeHash: false,
        extractText: false,
        generateThumbnail: false,
        text: entry.record.text ?? '',
      };
      const record = await this.add(entry.blob ?? new Blob([], { type: entry.record.mime }), addOptions);
      if (entry.record.deleted) await this.trash([record.id]);
      done += 1;
      options.onProgress?.(done, backup.entries.length);
    }
    return done;
  }

  /** Exports one record as a `File`, ready to be uploaded or downloaded. */
  async exportFile(id: string): Promise<File> {
    const record = await this.get(id);
    const blob = await this.getBlob(id);
    if (typeof File === 'undefined') {
      throw new NotSupportedError('File is not available in this environment; use getBlob()');
    }
    return new File([blob], record.name, { type: record.mime, lastModified: record.updatedAt });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Throws `ClosedError` when the connection is not open. */
  #assertOpen(): void {
    this.#requireDb();
  }

  #requireDb(): IDBDatabase {
    if (!this.#db) {
      throw new ClosedError(
        'The database is not open. Call `await db.open()` before using it, or use `FileDB.open()`.',
      );
    }
    return this.#db;
  }

  #emit(type: 'add' | 'update' | 'delete' | 'restore' | 'purge', record: FileRecord): void {
    this.#emitter.emit(type, record);
    this.#emitter.emit('change', { type, record, remote: false });
    this.#post(type, record);
  }

  #connectChannel(): void {
    if (!this.#options.syncTabs) return;
    const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (typeof Channel !== 'function') return;
    try {
      this.#channel = new Channel(`idb-file-store:${this.#options.name}`);
    } catch {
      this.#channel = null;
      return;
    }
    this.#channel.onmessage = (event: MessageEvent<BroadcastPayload>) => {
      const payload = event.data;
      if (!payload || payload.source === this.#instanceId) return;
      if (payload.type === 'clear') {
        this.#emitter.emit('change', { type: 'clear', remote: true });
        return;
      }
      if (payload.record) {
        this.#emitter.emit('change', {
          type: payload.type,
          record: payload.record,
          remote: true,
        });
      }
    };
  }

  #post(type: BroadcastPayload['type'], record: FileRecord | null): void {
    if (!this.#channel) return;
    const payload: BroadcastPayload = { source: this.#instanceId, type, record };
    try {
      this.#channel.postMessage(payload);
    } catch {
      // A closing channel is not worth surfacing to the caller.
    }
  }

  /** Reads every row, trashed ones included. */
  async #allRows(): Promise<StoredFile[]> {
    return this.transaction(STORE_FILES, 'readonly', async (tx) =>
      collectAll<StoredFile>(tx.objectStore(STORE_FILES), null),
    );
  }

  async #findByHash(hash: string): Promise<FileRecord | null> {
    return this.transaction(STORE_FILES, 'readonly', async (tx, wait) => {
      const index = tx.objectStore(STORE_FILES).index(INDEX.hash);
      const matches = await wait(index.getAll(IDBKeyRange.only(hash)) as IDBRequest<StoredFile[]>);
      const live = matches.find((row) => row.deletedAt === 0);
      return live ? toPublicRecord(live) : null;
    });
  }

  async #getOrNull(id: string, options: ReadOptions): Promise<FileRecord | null> {
    this.#assertOpen();
    const readOptions = resolveReadOptions(options);
    const stores = [STORE_FILES];
    if (readOptions.includeBlob) stores.push(STORE_CHUNKS);
    if (readOptions.includeThumbnail) stores.push(STORE_THUMBS);
    const mode: IDBTransactionMode = readOptions.touch ? 'readwrite' : 'readonly';

    return this.transaction(stores, mode, async (tx, wait) => {
      const store = tx.objectStore(STORE_FILES);
      const row = await wait(store.get(id) as IDBRequest<StoredFile | undefined>);
      if (!row) return null;

      if (readOptions.touch) {
        row.accessedAt = now();
        await wait(store.put(row));
      }

      const extras: { text?: string; blob?: Blob; thumbnail?: Blob } = {};
      if (readOptions.includeText) extras.text = row.text;
      if (readOptions.includeBlob) {
        extras.blob = await readChunks(tx, id, row.mime, row.chunkCount);
      }
      if (readOptions.includeThumbnail) {
        const thumb = await wait(
          tx.objectStore(STORE_THUMBS).get(id) as IDBRequest<StoredThumbnail | undefined>,
        );
        if (thumb) extras.thumbnail = thumb.blob;
      }
      return toPublicRecord(row, extras);
    });
  }

  async #requireRow(tx: IDBTransaction, wait: Wait, id: string): Promise<StoredFile> {
    const row = await wait(tx.objectStore(STORE_FILES).get(id) as IDBRequest<StoredFile | undefined>);
    if (!row) throw new NotFoundError(`No file with id "${id}"`);
    return row;
  }

  async #updateOrNull(id: string, options: UpdateOptions): Promise<FileRecord | null> {
    return this.#swallowMissing(() => this.update(id, options));
  }

  /**
   * Turns a missing record into `null` instead of an error.
   *
   * Bulk operations report what they changed rather than failing on the first
   * stale id, which is why the surrounding methods return arrays.
   */
  async #swallowMissing<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** Loads a record, lets `mutate` change it, then persists it. */
  async #patch(id: string, mutate: (row: StoredFile) => boolean): Promise<FileRecord | null> {
    this.#assertOpen();
    const updated = await this.#swallowMissing(() =>
      this.transaction(STORE_FILES, 'readwrite', async (tx, wait) => {
        const row = await this.#requireRow(tx, wait, id);
        mutate(row);
        row.revision += 1;
        row.updatedAt = now();
        await wait(tx.objectStore(STORE_FILES).put(row));
        return row;
      }),
    );
    return updated ? toPublicRecord(updated) : null;
  }

  /**
   * Picks a scan for `where`, or `null` when the filter cannot match anything.
   */
  #plan(where: Where | undefined): IndexPlan | null {
    this.#assertOpen();
    const plan = planIndex(where);
    return plan.empty ? null : plan;
  }

  /** Reads candidate rows using the best index the query allows. */
  async #candidates(where: Where | undefined): Promise<StoredFile[]> {
    const plan = this.#plan(where);
    if (!plan) return [];

    return this.transaction(STORE_FILES, 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_FILES);
      if (!plan.index) return collectAll<StoredFile>(store, plan.range);
      return collectAll<StoredFile>(store.index(plan.index), plan.range);
    });
  }

  /** Reads only the primary keys that the plan can reach. */
  async #collectKeys(where: Where | undefined): Promise<IDBValidKey[]> {
    const plan = this.#plan(where);
    if (!plan) return [];

    return this.transaction(STORE_FILES, 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_FILES);
      const source = plan.index ? store.index(plan.index) : store;
      return collectKeys(source, plan.range);
    });
  }

  /** Fetches rows by primary key in a single transaction. */
  async #getManyRows(keys: readonly IDBValidKey[]): Promise<StoredFile[]> {
    if (keys.length === 0) return [];
    this.#assertOpen();
    return this.transaction(STORE_FILES, 'readonly', async (tx, wait) => {
      const store = tx.objectStore(STORE_FILES);
      const rows = await Promise.all(
        keys.map((key) => wait(store.get(key) as IDBRequest<StoredFile | undefined>)),
      );
      return rows.filter((row): row is StoredFile => row !== undefined);
    });
  }

  /** Turns a selection into public records, attaching extras when requested. */
  async #materialize(selection: Selection, query: Query): Promise<FileRecord[]> {
    const wantBlob = query.includeBlob ?? false;
    const wantText = query.includeText ?? false;
    const wantThumb = query.includeThumbnail ?? false;
    if (!wantBlob && !wantText && !wantThumb) {
      return selection.rows.map(({ row, score }) => withScore(toPublicRecord(row), score));
    }

    this.#assertOpen();
    const stores = [STORE_FILES];
    if (wantBlob) stores.push(STORE_CHUNKS);
    if (wantThumb) stores.push(STORE_THUMBS);

    return this.transaction(stores, 'readonly', async (tx, wait) => {
      const out: FileRecord[] = [];
      for (const { row, score } of selection.rows) {
        const extras: { text?: string; blob?: Blob; thumbnail?: Blob } = {};
        if (wantText) extras.text = row.text;
        if (wantBlob) extras.blob = await readChunks(tx, row.id, row.mime, row.chunkCount);
        if (wantThumb) {
          const thumb = await wait(
            tx.objectStore(STORE_THUMBS).get(row.id) as IDBRequest<StoredThumbnail | undefined>,
          );
          if (thumb) extras.thumbnail = thumb.blob;
        }
        out.push(withScore(toPublicRecord(row, extras), score));
      }
      return out;
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                       */
/* -------------------------------------------------------------------------- */

interface BroadcastPayload {
  source: string;
  type: 'add' | 'update' | 'delete' | 'restore' | 'purge' | 'clear';
  record: FileRecord | null;
}

function stripUndefined(options: FileDBOptions): Partial<FileDBOptions> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<FileDBOptions>;
}

function withScore(record: FileRecord, score: number | null): FileRecord {
  if (score !== null) record.score = score;
  return record;
}

function isFile(value: unknown): boolean {
  return typeof File !== 'undefined' && value instanceof File;
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Recomputes the denormalised search columns after a record changed. */
function refreshSearchColumns(row: StoredFile): void {
  const columns = buildSearchColumns({
    name: row.name,
    tags: row.tags,
    folder: row.folder,
    mime: row.mime,
    notes: row.notes,
    text: row.text,
    metadata: row.metadata,
  });
  row.nameLower = columns.nameLower;
  row.notesLower = columns.notesLower;
  row.textLower = columns.textLower;
  row.tagsLower = columns.tagsLower;
  row.metaText = columns.metaText;
}

/**
 * Applies the mutable fields of {@link UpdateOptions} onto a stored row.
 *
 * Grouped by subject, so a change to one concern stays in one place: what the
 * record is, where it sits, what it says, and how it is measured.
 */
function applyUpdateOptions(row: StoredFile, options: UpdateOptions): void {
  applyIdentityOptions(row, options);
  applyPlacementOptions(row, options);
  applyContentOptions(row, options);
  applyMeasurementOptions(row, options);
}

/** Name, MIME type and kind. Renaming also re-derives the extension. */
function applyIdentityOptions(row: StoredFile, options: UpdateOptions): void {
  if (options.name !== undefined) row.name = normalizeName(options.name);
  if (options.mime !== undefined) row.mime = normalizeMime(options.mime);
  if (options.kind !== undefined) row.kind = options.kind;
  if (options.name !== undefined) row.extension = extensionOf(row.name);
}

/** Tags, folder and the favourite flag. */
function applyPlacementOptions(row: StoredFile, options: UpdateOptions): void {
  if (options.tags !== undefined) row.tags = normalizeTags(options.tags);
  if (options.folder !== undefined) row.folder = prepareFolder(options.folder);
  if (options.favorite !== undefined) row.favorite = options.favorite ? 1 : 0;
}

/** Notes, structured metadata and the searchable text. */
function applyContentOptions(row: StoredFile, options: UpdateOptions): void {
  if (options.notes !== undefined) row.notes = options.notes;
  if (options.metadata !== undefined) row.metadata = prepareMetadata(options.metadata);
  if (options.text !== undefined) row.text = options.text ?? '';
}

/** Dimensions and duration, which callers supply or clear explicitly. */
function applyMeasurementOptions(row: StoredFile, options: UpdateOptions): void {
  if (options.width !== undefined) row.width = options.width;
  if (options.height !== undefined) row.height = options.height;
  if (options.durationMs !== undefined) row.durationMs = options.durationMs;
}

function bump(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function bumpSize(target: Record<string, { count: number; size: number }>, key: string, size: number): void {
  const entry = target[key] ?? { count: 0, size: 0 };
  entry.count += 1;
  entry.size += size;
  target[key] = entry;
}

async function readQuota(): Promise<{ usage: number | null; quota: number | null } | null> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (!storage?.estimate) return null;
  try {
    const estimate = await storage.estimate();
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
  } catch {
    return null;
  }
}

function collectAll<T>(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | null): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const request = source.getAll(range);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(wrapIdbError(request.error, 'Reading records failed'));
  });
}

function collectKeys(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | null): Promise<IDBValidKey[]> {
  return new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = source.getAllKeys(range);
    request.onsuccess = () => resolve(request.result as IDBValidKey[]);
    request.onerror = () => reject(wrapIdbError(request.error, 'Reading keys failed'));
  });
}

/** Re-exported for advanced callers that build their own transactions. */
export {
  STORE_CHUNKS,
  STORE_FILES,
  STORE_META,
  STORE_THUMBS,
  CHUNK_INDEX,
  waitForRequest,
  waitForTransaction,
  FileDBError,
};