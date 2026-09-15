# API reference

Everything exported from `idb-file-store`.

```ts
import { FileDB, FILE_KINDS, ValidationError, ... } from 'idb-file-store';
```

- [FileDB](#filedb)
  - [Construction and lifecycle](#construction-and-lifecycle)
  - [Events](#events)
  - [Transactions](#transactions)
  - [Creating records](#creating-records)
  - [Reading records](#reading-records)
  - [Updating records](#updating-records)
  - [Deleting records](#deleting-records)
  - [Querying](#querying)
  - [Aggregates](#aggregates)
  - [Backup and transfer](#backup-and-transfer)
- [Types](#types)
  - [FileRecord](#filerecord)
  - [AddOptions](#addoptions)
  - [UpdateOptions](#updateoptions)
  - [ReadOptions](#readoptions)
  - [Query](#query-1)
  - [Where](#where)
  - [Sort](#sort)
  - [SearchQuery](#searchquery)
  - [Page](#page)
  - [StorageStats and Facets](#storagestats-and-facets)
- [Error classes](#error-classes)
- [Utility exports](#utility-exports)

---

## FileDB

### Construction and lifecycle

#### `new FileDB(options?)`

Creates an instance. It does **not** touch IndexedDB until you call `open()`.
Construct one instance per database name and share it across your app.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | `'idb-file-store'` | Database name. Different names are fully independent vaults. |
| `version` | `number` | current schema | Only raise this to run a migration. |
| `chunkSize` | `number` | `2 * 1024 * 1024` | Bytes per chunk written to disk. |
| `extractText` | `boolean` | `true` | Pull text out of text-like payloads for search. |
| `maxTextBytes` | `number` | `256 * 1024` | Cap on extracted text. |
| `generateThumbnails` | `boolean` | `true` | Generate previews for images. |
| `thumbnailMaxSize` | `number` | `256` | Longest edge of a preview, in pixels. |
| `computeHash` | `boolean` | `true` | Hash payloads on write. |
| `hashMaxBytes` | `number` | `64 * 1024 * 1024` | Skip hashing above this size. |
| `dedupe` | `boolean` | `false` | Return an existing record instead of storing identical bytes again. |
| `syncTabs` | `boolean` | `true` | Broadcast changes to other tabs. |
| `indexedDB` | `IDBFactory` | `globalThis.indexedDB` | Injectable factory, useful in tests. |

#### `FileDB.open(options?) => Promise<FileDB>`

Static helper that constructs and opens in one step.

```ts
const db = await FileDB.open({ name: 'my-vault' });
```

#### `await db.open() => Promise<this>`

Opens the connection, running migrations when needed. Safe to call concurrently:
later calls share the first promise.

#### `db.close() => void`

Closes the connection and the broadcast channel. Throws nothing if already
closed. The database itself stays on disk.

#### `await db.destroy() => Promise<void>`

Closes the connection **and deletes the database** from the browser's storage.

#### `db.name`, `db.version`, `db.isOpen`

Read-only accessors: the database name, the expected schema version, and whether
the connection is currently open.

Every method except `open()`, `close()`, `destroy()`, `on()` and `off()` throws
`ClosedError` when the database is not open.

---

### Events

#### `db.on(event, listener) => () => void`

Subscribes and returns an unsubscribe function.

#### `db.once(event, listener) => () => void`

Subscribes for a single emission.

#### `db.off(event, listener?) => void`

Removes one listener, or every listener for the event when `listener` is
omitted.

| Event | Payload | Fires when |
| --- | --- | --- |
| `add` | `FileRecord` | A record was created. |
| `update` | `FileRecord` | A record changed. |
| `delete` | `FileRecord` | A record was trashed. |
| `restore` | `FileRecord` | A record left the trash. |
| `purge` | `FileRecord` | A record was permanently removed. |
| `duplicate` | `FileRecord` | An `add` was skipped because identical bytes already existed. |
| `change` | `FileDBChange` | Any of the above, plus `clear`. |
| `open` | `{ name, version }` | The connection opened. |
| `close` | `{ name }` | The connection closed. |
| `destroy` | `{ name }` | The database was deleted. |

`FileDBChange` is `{ type: 'add' | 'update' | 'delete' | 'restore' | 'purge' | 'clear', record?, remote }`.
`remote: true` marks a change that arrived from another tab, so you can avoid
echoing it back into your own state twice.

A listener that throws is logged and isolated; it never fails the write that
triggered it.

```ts
const off = db.on('change', ({ type, record, remote }) => {
  if (remote) refresh();
  console.log(type, record?.name);
});
off();
```

---

### Transactions

#### `await db.transaction(stores, mode, body) => Promise<T>`

Escape hatch for composing several operations atomically.

```ts
const count = await db.transaction(['files', 'chunks'], 'readwrite', async (tx, wait) => {
  const store = tx.objectStore('files');
  const row = await wait(store.get(id) as IDBRequest<StoredFile | undefined>);
  if (!row) return 0;
  row.favorite = 1;
  await wait(store.put(row));
  return 1;
});
```

`stores` is a store name or an array of them; `mode` is `'readonly'` or
`'readwrite'`. **Inside `body` you may only await IndexedDB requests issued
through `wait`.** Awaiting a timer, `fetch` or anything else lets the browser
commit the transaction early and later requests throw `TransactionInactiveError`.

---

### Creating records

#### `await db.add(input, options?) => Promise<FileRecord>`

Stores a payload and returns its record. `input` may be a `File`, `Blob`,
`ArrayBuffer`, typed array, or `string` (stored as text).

```ts
const record = await db.add(file, {
  tags: ['holiday'],
  folder: '/photos/2024',
  metadata: { camera: 'X-T5' },
});
```

See [AddOptions](#addoptions) for every option.

- Throws `ValidationError` when the name is empty, the id already exists, tags or
  metadata are unusable, or `chunkSize` is not positive.
- With `dedupe: true` and a computed hash, an existing live record with the same
  bytes is returned instead of writing a copy, and the `duplicate` event fires.
- With `id` supplied, that id is used; otherwise a UUID is generated.

#### `await db.addMany(inputs, options?) => Promise<FileRecord[]>`

Adds a list of payloads, one transaction each, calling `options.onProgress(done, total, record)`
after every file. Individual failures reject the returned promise; files already
written stay.

#### `await db.importFiles(files, options?) => Promise<FileRecord[]>`

Adds a `FileList` or `File[]`. Set `preserveRelativePath: true` to map each
`webkitRelativePath` into `folder`, which is how you restore a directory-picker
upload's structure.

```ts
await db.importFiles(input.files, {
  preserveRelativePath: true,
  folder: '/uploads',
  onProgress: (done, total) => setProgress(done / total),
});
```

---

### Reading records

#### `await db.get(id, options?) => Promise<FileRecord>`

Reads one record. Throws `NotFoundError` when the id is unknown.

#### `await db.find(id, options?) => Promise<FileRecord | null>`

Same, but returns `null` instead of throwing.

#### `await db.has(id) => Promise<boolean>`

`true` when a **live** record with this id exists. Trashed records report `false`.

#### `await db.getBlob(id) => Promise<Blob>`

Reassembles and returns the bytes.

#### `await db.readRange(id, start, end) => Promise<Blob>`

Returns `[start, end)` without reading the whole file; only the chunks that
overlap the window are fetched. Ideal for `Range` requests from a media element.

#### `await db.getText(id) => Promise<string>`

The extracted or supplied text, or `''`.

#### `await db.getThumbnail(id) => Promise<Blob | null>`

The generated preview, or `null` when there is none.

#### `await db.getObjectURL(id) => Promise<string>`

Creates a blob URL. Throws `NotSupportedError` when `URL.createObjectURL` is
unavailable.

#### `db.revokeObjectURL(url) => void`

Releases a URL from `getObjectURL()`.

#### `await db.download(id, filename?) => Promise<void>`

Triggers a browser download through a temporary anchor. Throws
`NotSupportedError` outside a DOM; in a worker, use `getBlob()` and post the
bytes instead.

---

### Updating records

#### `await db.update(id, options?) => Promise<FileRecord>`

Applies a partial change. Only the keys you pass are touched; `updatedAt` and
`revision` always move forward.

```ts
await db.update(id, { name: 'renamed.md', tags: ['done'], favorite: false });
await db.update(id, { text: null });          // clear the searchable text
await db.update(id, { data: newBlob });       // replace the bytes
```

Passing `data` re-runs chunking, hashing, text extraction and thumbnail
generation. The record's name and MIME type are inherited unless you override
them, so a payload-only update keeps the file's identity.

#### `await db.updateMany(ids, options?) => Promise<FileRecord[]>`

Applies the same change to many records, skipping ids that no longer exist.

#### `await db.setTags(id, { add?, remove? }) => Promise<FileRecord>`

Adds and removes tags without replacing the list. Matching is
case-insensitive; `remove` wins over `add`.

#### `await db.move(ids, folder) => Promise<FileRecord[]>`

Moves records into a folder path.

#### `await db.setFavorite(ids, value) => Promise<FileRecord[]>`

Stars or unstars records.

---

### Deleting records

#### `await db.trash(ids) => Promise<FileRecord[]>`

Moves records to the trash. Recoverable, and they keep their bytes. Trashed
records are excluded from every query unless `where.deleted` is `true`.

#### `await db.restore(ids) => Promise<FileRecord[]>`

Brings records back from the trash.

#### `await db.purge(ids) => Promise<number>`

Permanently removes records, their chunks and their thumbnails. Returns how many
records were actually removed. Missing ids are ignored.

#### `await db.emptyTrash() => Promise<number>`

Purges everything currently in the trash.

#### `await db.clear() => Promise<void>`

Empties every object store but leaves the database in place and usable.

#### `await db.pruneOrphans() => Promise<number>`

Deletes chunk and thumbnail rows with no owning record. Useful after a crash or
a bug, and after importing a database out of band.

---

### Querying

#### `await db.list(query?) => Promise<Page<FileRecord>>`

The main entry point: filter, search, sort and page in one call.

#### `await db.all(query?) => Promise<FileRecord[]>`

Every match, ignoring `limit`. Convenient for exports; can be large.

#### `await db.first(query?) => Promise<FileRecord | null>`

The first match, or `null`.

#### `await db.count(query?) => Promise<number>`

Number of matches, without building the page.

#### `await db.search(text, query?) => Promise<Page<FileRecord>>`

Shorthand for `list({ ...query, search: text })`. Hits carry a `score`.

#### `db.iterate(options?) => AsyncGenerator<FileRecord>`

Streams matches without collecting them. With `sort`, records are collected
first (ordering cannot be streamed); without it, keys are read up front and
records arrive in batches of 250.

```ts
for await (const record of db.iterate({ search: 'invoice' })) {
  console.log(record.name);
}
```

`options.signal` accepts an `AbortSignal`; aborting stops the loop at the next
batch boundary.

---

### Aggregates

#### `await db.facets(query?) => Promise<Facets>`

Counts and ranges over a result set, for building filter panes.

```ts
const facets = await db.facets({ where: { kind: 'image' } });
// { count, size, sizeRange: {min,max}, dateRange: {oldest,newest},
//   byKind, byExtension, byTag, byFolder }
```

#### `await db.stats() => Promise<StorageStats>`

Totals across the whole database: live and trashed counts and bytes, per-kind and
per-MIME breakdowns, the oldest and newest `createdAt`, and the browser quota
from `navigator.storage.estimate()` when available.

---

### Backup and transfer

#### `await db.snapshot() => Promise<Snapshot>`

Metadata for every record, trashed ones included, with no bytes. Safe to
`JSON.stringify`. Good for exporting a catalogue or diffing two databases.

#### `await db.backup() => Promise<Backup>`

Every record **with** its bytes. This holds the database in memory, so use it for
user-driven "download a backup" flows rather than scheduled jobs. Thumbnails are
derived data and are not included.

#### `await db.restoreBackup(backup, options?) => Promise<number>`

Writes a backup back. `options.replace` clears the database first;
`options.onProgress(done, total)` reports progress. Throws `ValidationError` for
an unknown format version.

#### `await db.exportFile(id) => Promise<File>`

Wraps the record and its bytes in a real `File`, ready to upload. Throws
`NotSupportedError` where `File` does not exist.

---

## Types

### FileRecord

What `add`, `get`, `list` and friends return.

```ts
interface FileRecord {
  id: string;
  name: string;
  kind: FileKind;
  mime: string;
  extension: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  accessedAt: number;
  hash: string | null;
  tags: string[];
  folder: string;            // always starts with '/'
  favorite: boolean;
  deleted: boolean;
  deletedAt: number | null;
  notes: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  chunkCount: number;
  chunkSize: number;
  metadata: Record<string, JsonValue>;
  revision: number;

  // present only when requested
  text?: string;             // includeText
  blob?: Blob;               // includeBlob
  thumbnail?: Blob;          // includeThumbnail
  score?: number;            // when the query used `search`
}
```

`FileKind` is one of `image`, `video`, `audio`, `text`, `document`,
`spreadsheet`, `presentation`, `archive`, `code`, `font`, `other`; the exported
`FILE_KINDS` array lists them all in a stable order.

### AddOptions

| Option | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Explicit id. Random UUID when omitted. |
| `name` | `string` | Display name. Derived from `File.name`, then the MIME type. |
| `mime` | `string` | Overrides detection. |
| `kind` | `FileKind` | Overrides detection. |
| `tags` | `string[]` | Initial tags, trimmed and de-duplicated case-insensitively. |
| `folder` | `string` | Normalised to `/a/b` form. |
| `favorite` | `boolean` | Star on creation. |
| `notes` | `string` | Searchable notes. |
| `metadata` | `Record<string, JsonValue>` | Structured data. Must survive a JSON round trip. |
| `createdAt` / `updatedAt` | `number \| Date` | Override timestamps. |
| `text` | `string` | Supply searchable text instead of extracting it. |
| `extractText` | `boolean` | Per-call override of the database option. |
| `generateThumbnail` | `boolean` | Per-call override. |
| `chunkSize` | `number` | Per-call override. |
| `computeHash` | `boolean` | Per-call override. |
| `dedupe` | `boolean` | Return an existing identical record instead of writing. |
| `width` / `height` | `number` | Known pixel size, when detection is unavailable. |
| `durationMs` | `number` | Known media duration. |

`ImportOptions` extends `AddOptions` with `preserveRelativePath` and
`onProgress(done, total, record)`.

### UpdateOptions

Every mutable field from `AddOptions` (`name`, `mime`, `kind`, `tags`, `folder`,
`favorite`, `notes`, `metadata`, `updatedAt`), plus:

| Option | Type | Meaning |
| --- | --- | --- |
| `data` | `FileInput` | Replacement bytes; re-runs chunking, hashing, extraction and thumbnails. |
| `text` | `string \| null` | Replace the searchable text; `null` clears it. |
| `width` / `height` / `durationMs` | `number \| null` | Set or clear derived dimensions. |

### ReadOptions

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `includeBlob` | `boolean` | `false` | Attach the bytes. |
| `includeText` | `boolean` | `false` | Attach the extracted text. |
| `includeThumbnail` | `boolean` | `false` | Attach the generated preview. |
| `touch` | `boolean` | `false` | Bump `accessedAt`, which turns the read into a write. |

### Query

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `where` | `Where` | `{}` | Declarative filter. |
| `search` | `string \| SearchQuery` | — | Full-text search, optionally ranked and scored. |
| `sort` | `Sort \| Sort[]` | `createdAt` desc | One or more sort instructions. |
| `limit` | `number` | `100` | Maximum items in the page. |
| `offset` | `number` | `0` | Records to skip. Ignored when `cursor` is set. |
| `cursor` | `string \| null` | — | Cursor from a previous `Page`. |
| `includeBlob` / `includeText` / `includeThumbnail` | `boolean` | `false` | Attach extras to every item. |

### Where

| Clause | Accepted shapes |
| --- | --- |
| `id` | `string` or `string[]` |
| `name` | `string`, `string[]`, or `{ eq, ne, contains, startsWith, endsWith, in, notIn, regex }` |
| `kind` | `FileKind` or `FileKind[]` |
| `mime`, `extension` | Same shapes as `name` |
| `size` | `{ eq, ne, gt, gte, lt, lte, between: [min, max] }` |
| `createdAt`, `updatedAt`, `accessedAt` | `Date`, `number`, or the size operators with `Date` or numbers |
| `folder` | `string`, `string[]`, `{ eq }`, or `{ startsWith }` for a subtree |
| `tags` | `string[]` (must have all), or `{ all?, any?, none? }` |
| `favorite` | `boolean` |
| `deleted` | `boolean`, default `false` |
| `hash` | `string` or `string[]` |
| `metadata` | `Record<string, JsonValue>`; dotted paths, array values mean "any of" |
| `metadataContains` | `Record<string, string>`; case-insensitive substring on metadata values |
| `custom` | `(record: FileRecord) => boolean` |

### Sort

```ts
type SortField =
  | 'name' | 'size' | 'createdAt' | 'updatedAt' | 'accessedAt'
  | 'kind' | 'mime' | 'extension' | 'folder' | 'favorite' | 'revision';

interface Sort { by: SortField; order?: 'asc' | 'desc'; }
```

Text fields are compared with `Intl.Collator` using numeric and
case-insensitive ordering, so `file2.txt` sorts before `file10.txt`.

### SearchQuery

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `text` | `string` | required | Text to look for. |
| `fields` | `SearchField[]` | all | Restrict matching to `name`, `text`, `notes`, `tags`, `folder`, `mime`, `metadata`. |
| `mode` | `'all' \| 'any'` | `'all'` | Require every token or just one. |
| `fuzzy` | `boolean` | `false` | Allow one-character typos in tokens of four or more characters. |
| `boost` | `number` | `1` | Multiplier applied to the score. |

### Page

```ts
interface Page<T> {
  items: T[];
  total: number;        // matches, before limit/offset
  offset: number;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}
```

`nextCursor` is an opaque base64url string. Treat it as a token: it is safe in
URLs, `localStorage` and state atoms, but its contents are an implementation
detail.

### StorageStats and Facets

```ts
interface StorageStats {
  count: number;
  size: number;
  trashedCount: number;
  trashedSize: number;
  byKind: Record<string, { count: number; size: number }>;
  byMime: Record<string, { count: number; size: number }>;
  range: { oldest: number | null; newest: number | null };
  quota: { usage: number | null; quota: number | null } | null;
}

interface Facets {
  count: number;
  size: number;
  sizeRange: { min: number | null; max: number | null };
  dateRange: { oldest: number | null; newest: number | null };
  byKind: Record<string, number>;
  byExtension: Record<string, number>;
  byTag: Record<string, number>;
  byFolder: Record<string, number>;
}
```

---

## Error classes

All extend `FileDBError`, which extends `Error` and sets `name` to the concrete
class, so a single `instanceof FileDBError` check catches everything the library
throws.

| Class | Thrown when |
| --- | --- |
| `ValidationError` | Bad input: empty name, unusable tags or metadata, negative `limit`, malformed cursor, duplicate id. |
| `NotFoundError` | A record does not exist, or its bytes are missing from the chunk store. |
| `ClosedError` | A method is used before `open()`, or after `close()`. |
| `NotSupportedError` | The runtime lacks a needed API (`indexedDB`, `URL.createObjectURL`, `File`, a canvas). |
| `QuotaError` | The browser refused a write because storage is full. |
| `ConflictError` | A write collided with an existing record under a unique constraint. |
| `FileDBError` | Base class and catch-all for wrapped IndexedDB failures. |

```ts
import { FileDBError, QuotaError } from 'idb-file-store';

try {
  await db.add(file);
} catch (error) {
  if (error instanceof QuotaError) showStorageWarning();
  else if (error instanceof FileDBError) report(error);
  else throw error;
}
```

---

## Utility exports

Small helpers the library uses itself, exported so applications can stay
consistent with it.

| Export | Purpose |
| --- | --- |
| `FILE_KINDS` | Every `FileKind`, in a stable order, for building filter lists. |
| `Emitter` | The typed event emitter used internally. |
| `encodeCursor`, `decodeCursor` | Build or inspect pagination cursors. |
| `planIndex` | See which index a `Where` clause would use; handy when tuning queries. |
| `resolveSearch`, `scoreRecord`, `DEFAULT_SEARCH_FIELDS` | Reuse the ranking model, e.g. to re-sort results after a client-side merge. |
| `DEFAULT_LIMIT` | The default page size (`100`). |
| `DEFAULT_CHUNK_SIZE`, `normalizeChunkSize` | Chunk sizing rules. |
| `generateThumbnail`, `readImageDimensions`, `fitWithin`, `supportsImageDecoding`, `DEFAULT_THUMBNAIL_SIZE` | Preview generation, usable standalone. |
| `contentHash`, `supportsWebCrypto` | Content hashing with the documented fallback. |
| `extensionOf`, `extensionFromMime`, `mimeFromName`, `kindFromMime`, `normalizeMime`, `isTextLikeMime` | MIME and kind detection. |
| `normalizeFolder`, `isInsideFolder` | Folder path rules. |
| `normalizeText`, `tokenize`, `boundedLevenshtein` | The text pipeline behind search. |
| `toBlob`, `formatBytes` | Input coercion and human-readable sizes. |
| `FileDBStats` | Alias of `StorageStats`, for callers who prefer an explicit name. |
