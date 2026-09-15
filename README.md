# idb-file-store

**A queryable, local-first file database for the browser.** Store, search, filter,
sort and manage images, video, audio, documents and any other user files with
IndexedDB. No server, no upload, no account.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-111%20passing-brightgreen.svg)](test)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)

```ts
import { FileDB } from 'idb-file-store';

const db = new FileDB({ name: 'my-vault' });
await db.open();

await db.add(file, { tags: ['holiday'], folder: '/photos/2024' });

const page = await db.list({
  where: { kind: 'image', size: { gte: 1024 } },
  search: 'beach sunset',
  sort: { by: 'createdAt', order: 'desc' },
  limit: 24,
});

console.log(page.total, page.items.map((file) => file.name));
```

---

## Why

`IndexedDB` gives you a key/value store and single-field indexes. A file manager
needs much more: filter by type and size and date, search inside names and text,
sort naturally, page through results, show storage usage, keep a trash, and stay
in sync across tabs. `idb-file-store` is that layer.

- **Library, not a framework.** Zero runtime dependencies, no DOM assumptions,
  works in workers, ships ESM and CJS with strict TypeScript types.
- **Bytes are handled properly.** The library slices every payload into chunks on
  write, so a two-hour video never becomes one giant allocation, and seeking reads
  only the chunks that overlap.
- **Querying IndexedDB cannot do alone.** Relevance-ranked full-text search,
  natural ordering (`file2` before `file10`), computed pagination cursors.
- **Batteries included.** Content hashing and de-duplication, auto text
  extraction, image thumbnails, a trash with restore, storage statistics,
  JSON backups, object URLs and downloads.

## Install

The package is not on npm yet, so install it from GitHub:

```bash
npm install github:lleqsnoom/idb-file-store
```

Once it is published, `npm install idb-file-store` will work instead.

## Quick start

```ts
import { FileDB } from 'idb-file-store';

const db = new FileDB({ name: 'my-vault' });
await db.open();

// --- create ---------------------------------------------------------------
const photo = await db.add(await fetch('/holiday.jpg').then((r) => r.blob()), {
  name: 'holiday.jpg',
  tags: ['trip', 'sunset'],
  folder: '/photos/2024',
  notes: 'golden hour',
  metadata: { camera: 'X-T5', iso: 400 },
});

// --- read -----------------------------------------------------------------
const record = await db.get(photo.id, { includeBlob: true });
const bytes = await db.getBlob(photo.id);
const text = await db.getText(photo.id);
const url = await db.getObjectURL(photo.id);   // remember db.revokeObjectURL(url)

// --- update ---------------------------------------------------------------
await db.update(photo.id, { favorite: true, folder: '/photos/best' });
await db.setTags(photo.id, { add: ['print'], remove: ['trip'] });
await db.update(photo.id, { data: replacementBlob });   // replace the bytes

// --- query ----------------------------------------------------------------
const results = await db.list({
  where: {
    kind: 'image',
    size: { between: [10_000, 5_000_000] },
    createdAt: { gte: new Date('2024-01-01') },
    tags: { all: ['trip'], none: ['private'] },
    metadata: { camera: 'X-T5' },
  },
  search: 'sunset',
  sort: [{ by: 'favorite', order: 'desc' }, { by: 'size', order: 'desc' }],
  limit: 20,
});

// --- delete ---------------------------------------------------------------
await db.trash([photo.id]);      // recoverable
await db.restore([photo.id]);    // bring it back
await db.purge([photo.id]);      // gone for good
```

## Features

| Area | What you get |
| --- | --- |
| **CRUD** | `add`, `addMany`, `importFiles`, `get`, `find`, `has`, `update`, `updateMany`, `setTags`, `move`, `setFavorite`, `trash`, `restore`, `purge`, `emptyTrash`, `clear` |
| **Querying** | `list`, `all`, `first`, `count`, `search`, `iterate`, `facets`, `stats` |
| **Filtering** | kind, MIME, extension, size, created/updated/accessed time, folder (recursive), tags, favourite, trash state, content hash, nested metadata, custom predicates |
| **Sorting** | name, size, timestamps, kind, MIME, extension, folder; multi-key, natural ordering |
| **Search** | field-weighted relevance ranking, tokenised, field allow-list, `all`/`any` modes, optional one-character typo tolerance |
| **Pagination** | `limit` + `offset`, or opaque cursors that survive round trips |
| **Files** | content-addressed storage, byte-range reads, auto MIME/kind detection, text extraction, image thumbnails and dimensions |
| **Integrity** | SHA-256 content hashing, shared storage for identical bytes, optional record de-duplication |
| **Maintenance** | trash with restore, orphan pruning, `navigator.storage` quotas, JSON snapshots, full backups |
| **Reactivity** | typed events (`add`, `update`, `delete`, `restore`, `purge`, `change`) and cross-tab sync over `BroadcastChannel` |
| **Extras** | object URLs, browser downloads, `File` export, storage statistics, filter facets |

## Core concepts

**Records.** `add()` returns a `FileRecord`: id, name, kind, MIME type, extension,
size, timestamps, hash, tags, folder, favourite flag, trash state, dimensions,
metadata and revision. Bytes are **not** part of the record; ask for them with
`includeBlob`, `getBlob()` or `readRange()`.

**Kinds.** Every file is bucketed into one `FileKind`: `image`, `video`, `audio`,
`text`, `document`, `spreadsheet`, `presentation`, `archive`, `code`, `font` or
`other`. Derive it automatically from the MIME type, or pass `kind` explicitly.

**Folders.** A flat path such as `/photos/2024`. Filter with an exact match or
`{ startsWith: '/photos' }` for the whole subtree. Folders are strings, not
entities, so you can build a tree with `facets().byFolder`.

**Chunks.** The library slices every payload into fixed-size chunks on write (2 MiB by
default, configurable per call). Deleting a file is a range delete, and `readRange()`
loads only the chunks that overlap the requested window.

**Content.** Chunks are addressed by a content id: the payload's hash when one was
computed, a private id otherwise. Two records whose bytes are identical therefore share
one copy on disk, whatever names or folders you gave them. The copy goes away when the
last record referencing it is purged, and `stats().physicalSize` reports what is really
stored. `dedupe` is a separate choice: it refuses the second *record* rather than sharing
its bytes.

**Search columns.** Each record keeps denormalised lowercase columns for name,
tags, folder, MIME, notes, extracted text and metadata. Search is a handful of
`indexOf` calls per candidate, which is fast enough for large libraries and
needs no extra object store.

**Trash.** `trash()` sets a flag instead of deleting. Trashed records are
invisible to queries unless you pass `where: { deleted: true }`. `purge()` and
`emptyTrash()` remove the record, its chunks and its thumbnail.

## API at a glance

### Creating

```ts
db.add(input, options?)                        // => FileRecord
db.addMany(inputs, options?)                   // => FileRecord[]
db.importFiles(fileList, options?)             // => FileRecord[]
```

`input` is a `File`, `Blob`, `ArrayBuffer`, typed array or `string`.
Key options: `name`, `mime`, `kind`, `tags`, `folder`, `favorite`, `notes`,
`metadata`, `createdAt`, `updatedAt`, `text`, `extractText`, `generateThumbnail`,
`chunkSize`, `computeHash`, `dedupe`, `id`.

### Reading

```ts
db.get(id, { includeBlob, includeText, includeThumbnail, touch })
db.find(id, options?)      // null instead of throwing
db.has(id)
db.getBlob(id)
db.readRange(id, start, end)
db.getText(id)
db.getThumbnail(id)
db.getObjectURL(id)        // + db.revokeObjectURL(url)
db.exportFile(id)          // => File
db.download(id, filename?)
```

### Updating

```ts
db.update(id, { name, tags, folder, favorite, notes, metadata, text, data, ... })
db.updateMany(ids, options)
db.setTags(id, { add: [...], remove: [...] })
db.move(ids, folder)
db.setFavorite(ids, true)
```

### Deleting

```ts
db.trash(ids)        // => FileRecord[]   recoverable
db.restore(ids)      // => FileRecord[]
db.purge(ids)        // => number         permanent, removes bytes too
db.emptyTrash()      // => number
db.clear()           // empties every store
db.pruneOrphans()    // => number         drops chunks with no record
```

### Querying

```ts
db.list(query)       // => Page<FileRecord>
db.all(query)        // every match, ignoring limit
db.first(query)      // => FileRecord | null
db.count(query)      // => number
db.search(text, query?)
db.iterate({ where, search, sort, signal })   // AsyncGenerator<FileRecord>
db.facets(query)     // => Facets                  counts for filter UIs
db.stats()           // => StorageStats            totals, per-kind, quota
```

A `Query` accepts `where`, `search`, `sort`, `limit`, `offset`, `cursor`,
`includeBlob`, `includeText` and `includeThumbnail`. A `Page` gives you `items`,
`total`, `offset`, `limit`, `hasMore` and `nextCursor`.

### Maintenance

```ts
db.snapshot()               // metadata only, JSON-safe
db.backup()                 // every record with its bytes
db.restoreBackup(backup, { replace })
db.transaction(stores, mode, (tx, wait) => ...)   // escape hatch
db.on('change', handler)    // typed events + cross-tab sync
```

Full signatures and edge cases live in **[docs/api.md](docs/api.md)**.

## Querying

```ts
await db.list({
  where: {
    kind: ['image', 'video'],                       // one or many
    mime: { startsWith: 'image/' },                 // eq, ne, contains, startsWith,
                                                    // endsWith, in, notIn, regex
    size: { gte: 1024, lt: 10_000_000 },            // eq, ne, gt, gte, lt, lte, between
    createdAt: { between: [new Date('2024-01-01'), new Date('2024-12-31')] },
    folder: { startsWith: '/photos' },              // subtree match
    tags: { all: ['trip'], any: ['sunset', 'beach'], none: ['private'] },
    name: { contains: 'beach' },
    favorite: true,
    deleted: false,                                 // the default
    hash: 'sha256:...',
    metadata: { 'exif.iso': 400 },                  // dotted paths, nested objects
    metadataContains: { camera: 'fuji' },
    custom: (record) => record.size < 5_000_000,    // escape hatch
  },
  search: {
    text: 'beach sunset',
    fields: ['name', 'tags'],   // default: everything
    mode: 'all',                // or 'any'
    fuzzy: true,                // one-character typos, tokens of 4+ characters
    boost: 2,
  },
  sort: [{ by: 'favorite', order: 'desc' }, { by: 'size', order: 'desc' }],
  limit: 24,
  offset: 0,
});
```

Search hits come back with a `score`, ranked highest first. The full reference
is in **[docs/querying.md](docs/querying.md)**, and
**[docs/recipes.md](docs/recipes.md)** has end-to-end examples for galleries,
video streaming, folder trees and upload de-duplication.

## Example app

`examples/playground` is a small vanilla-TypeScript file manager built on the
library: drag-and-drop upload, live search, faceted filters, sortable list,
thumbnail grid, trash and storage stats. It is the reference for wiring the
library into a UI.

```bash
npm install
npm run example        # http://localhost:5173
```

## Design notes

- **Indexes do the narrowing.** The planner walks the `where` clauses in a fixed
  preference order and uses the first one an index can answer, turning it into an
  `IDBKeyRange`. The remaining clauses still run as predicates, so the choice
  affects speed only, never results. `planIndex()` shows you the decision.
- **Ordering and ranking happen in memory.** IndexedDB cannot sort
  case-insensitively or rank by relevance, so the library loads the candidate rows
  (metadata only, never bytes), then scores and sorts them. The cost grows with the
  size of the candidate set, not the size of the database, so a narrow `where` keeps
  a query cheap however much is stored. `iterate()` avoids collecting at all.
- **One write, one transaction.** A record, its chunks and its thumbnail commit
  together, so a crash cannot leave half a file behind. `pruneOrphans()` cleans
  up anything that predates a bug or an aborted upgrade.
- **Transactions are strict.** Inside `db.transaction()` you may only await
  IndexedDB requests issued through the provided `wait` helper; awaiting a timer
  or a network call lets the browser commit early.

## Performance and limits

Two design choices decide how this library behaves under load. Both are
deliberate, and both have a cost.

**Writes are chunked.** The library slices every payload into fixed-size chunks
(2 MiB by default), so a large video never becomes one allocation and a seek reads
only the chunks it overlaps. The cost lands on reads: assembling a whole file
concatenates its chunks, and deleting one walks a range in the content index.

**Content is shared.** Chunks are keyed by the payload's hash, so identical bytes are
stored once however many records point at them, and the copy is released when the last
one is purged. The cost is one extra read: `add()` hashes the payload before opening
the write transaction, because a transaction cannot await non-JS work, and then slices
it. Peak memory stays at one chunk.

**Queries scan candidates in memory.** IndexedDB can order by only one index and
cannot compare case-insensitively, so ordering and relevance ranking run over the
candidate rows in JavaScript. Cost therefore scales with the number of candidate
rows, not with how much you have stored. Narrow the candidate set with `where` and
the same query stays cheap on a large library.

Two operations are explicitly eager:

- `backup()` reads every record **and its bytes** into memory at once. Use it for a
  user-driven "download a backup" flow, not on a schedule.
- `snapshot()` reads every record's metadata, which is small, and no bytes.

There is no benchmark in this repository, so no throughput or latency numbers are
quoted. If you need figures for your own workload, `planIndex()` shows which index
a query will use, and `facets()` and `stats()` show how many records a filter
matches before you page through them.

## How it compares

| Library | What it is for | How this differs |
| --- | --- | --- |
| [Dexie](https://dexie.org/) | A general IndexedDB wrapper with a query DSL and live queries. | Dexie models tables and rows. This models *files*: kind detection, chunked bytes, previews, a trash, and file-shaped queries such as "images over 1 MB, newest first". They compose well: you could store metadata in Dexie and bytes here. |
| [localForage](https://localforage.github.io/localForage/) | A `localStorage`-style key/value API over IndexedDB, WebSQL and localStorage. | localForage gives you `getItem`/`setItem`. It has no filtering, sorting, search or paging, so every list view means loading the whole store. |
| [SQLite-WASM](https://sqlite.org/wasm) / OPFS | A full SQL engine compiled to WebAssembly, with a synchronous file API on some origins. | Real SQL and real transactions, at the cost of a WASM payload and OPFS or worker plumbing. This library ships as plain JavaScript, needs no WASM, and works on any origin that has IndexedDB. |

If you need joins, aggregates over millions of rows, or a shared schema with a
server database, SQLite-WASM is the better tool. If you need a local file library
with search, filters and previews inside a page bundle, this is.

## Browser support

These floors come from the newest requirement of the core API, `structuredClone`:
**Chrome/Edge 98+, Firefox 94+, Safari 15.4+**, and the matching workers. Older
browsers may still handle basic storage, but the library does not test them.

Optional APIs degrade instead of throwing when they are missing:

| Feature | Without it |
| --- | --- |
| `crypto.subtle` | hashing falls back to a non-cryptographic digest, flagged by the `fnv128x:` hash prefix |
| `createImageBitmap` | no thumbnails or image dimensions |
| `BroadcastChannel` | no cross-tab change events |
| `Intl.Collator` | falls back to the platform default string order |
| `navigator.storage` | `stats().quota` is `null` |
| `document` / `URL` | `download()` throws; use `getBlob()` instead |

Storage is subject to browser eviction policies. Call
`navigator.storage.persist()` in your app if the data must survive cleanup.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest, 111 tests on an in-memory IndexedDB
npm run build          # tsup -> dist (ESM, CJS, .d.ts)
npm run check          # all three
```

Tests run against [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB),
so they need no browser.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/api.md](docs/api.md) | Every class, method, option and type |
| [docs/querying.md](docs/querying.md) | Filters, sorting, search scoring, pagination |
| [docs/recipes.md](docs/recipes.md) | How to build galleries, viewers, trees and uploads |
| [docs/architecture.md](docs/architecture.md) | Schema, indexes, chunking, performance |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup and review checklist |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE)
