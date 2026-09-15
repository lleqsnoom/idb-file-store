# Architecture

How the library is put together, and why.

- [Module map](#module-map)
- [The schema](#the-schema)
- [Why bytes live in their own store](#why-bytes-live-in-their-own-store)
- [Why records carry denormalised columns](#why-records-carry-denormalised-columns)
- [Query pipeline](#query-pipeline)
- [Transaction discipline](#transaction-discipline)
- [Errors](#errors)
- [Concurrency and cross-tab behaviour](#concurrency-and-cross-tab-behaviour)
- [Migrations](#migrations)
- [Deliberate non-goals](#deliberate-non-goals)

---

## Module map

```
src/
  index.ts                    public surface
  file-db.ts                  the FileDB class: lifecycle, CRUD, orchestration
  types.ts                    public types
  errors.ts                   error hierarchy and IndexedDB error translation
  events.ts                   typed emitter used for change notifications

  storage/
    idb.ts                    promise wrappers, transaction runner, cursors
    schema.ts                 store and index definitions, migrations
    records.ts                on-disk row shapes
    chunk-store.ts            chunked blob reads and writes

  query/
    match.ts                  where-clause predicates
    plan.ts                   index selection
    search.ts                 tokenisation, field weights, relevance scoring
    sort.ts                   collation and cursor keys
    cursor.ts                 opaque pagination tokens
    select.ts                 filter -> score -> sort -> page

  utils/
    mime.ts                   extension and MIME detection, kind bucketing
    text.ts                   normalisation, tokenisation, edit distance
    path.ts                   folder paths and metadata validation
    hash.ts                   content hashing with a documented fallback
    thumbnail.ts              preview generation
    record.ts                 stored row <-> public record translation
    misc.ts                   ids, timestamps, input coercion, formatting
```

The dependency direction is one-way: `file-db` depends on `query`, `storage` and
`utils`; `query` and `storage` depend on `utils`; `utils` depends only on `types`
and `errors`. Nothing in `utils` or `query` touches IndexedDB directly, which is
why those layers are cheap to unit test.

---

## The schema

Schema version 1 creates four object stores.

### `files` — one row per file, metadata only

Keyed by `id`. Indexes:

| Index | Field | Purpose |
| --- | --- | --- |
| `by_name` | `nameLower` | Case-insensitive name equality and prefix ranges |
| `by_kind` | `kind` | `where: { kind }` |
| `by_mime` | `mime` | Exact MIME and prefix ranges |
| `by_extension` | `extension` | Extension filtering |
| `by_size` | `size` | Size ranges |
| `by_created` | `createdAt` | Date ranges, default sort order |
| `by_updated` | `updatedAt` | Date ranges |
| `by_accessed` | `accessedAt` | "Recently opened" |
| `by_folder` | `folder` | Exact folder equality |
| `by_tags` | `tags` (`multiEntry`) | Tag membership |
| `by_favorite` | `favorite` | Starred lists |
| `by_deleted` | `deletedAt` | Trash exclusion |
| `by_hash` | `hash` | De-duplication lookup |

Three of those deserve an explanation.

**`nameLower`.** IndexedDB compares strings byte-wise, so an index on `name`
would make `Banana.jpg` sort before `apple.jpg`. The row stores a normalised
lowercase copy and the index points at that.

**`deletedAt` instead of a `deleted` boolean.** Booleans are not valid IndexedDB
keys, so a `deleted` index would silently contain nothing. `deletedAt` is `0` for
live records and a timestamp for trashed ones, which is both indexable and more
informative. `backup()` and `snapshot()` can also report when a file was trashed.

**`hash` may be `null`.** IndexedDB skips records whose indexed value is not a
valid key, so a `null` hash simply does not appear in `by_hash`. That is the
desired behaviour: unhashed files are never de-duplication candidates.

### `chunks` — the bytes

Keyed by `[fileId, index]`, with a non-unique `by_file` index on `fileId`. See
below.

### `thumbnails` — generated previews

Keyed by `id`, the same id as the owning record. Kept separate so listing
thousands of records never pulls a single preview into memory.

### `meta` — bookkeeping

Keyed by `key`. Reserved for migration state and per-database settings.

---

## Why bytes live in their own store

A `Blob` can be stored directly in a record, and for a small icon that is fine.
It stops being fine when the file is a 3 GB video:

1. **Writing.** Storing one giant blob means one giant structured-clone value. It
   is slow, it doubles peak memory, and some engines refuse outright past a
   size ceiling.
2. **Reading.** `get(id)` would deserialize the whole payload even when the
   caller only wants the name.
3. **Deleting.** A record rewrite rewrites its bytes.
4. **Partial reads.** There is no way to ask for bytes 30–31 MB of a stored blob.

Chunking solves all four. Writes slice the payload into fixed-size pieces (2 MiB
by default) and put them keyed by `[fileId, index]`; reads assemble only what is
needed.

- `getBlob()` fetches every chunk for one file and concatenates through
  `new Blob(parts)`, which is lazy on the read side.
- `readRange(start, end)` computes `firstIndex = floor(start / chunkSize)` and
  `lastIndex = floor((end - 1) / chunkSize)` and fetches only those chunks, then
  trims the first and last to the requested window.
- `deleteChunks()` walks the `by_file` index and deletes each key, so no
  per-chunk bookkeeping is needed elsewhere.
- `pruneOrphans()` scans chunk keys, compares them against the set of live record
  ids, and removes anything unmatched. This is the safety net for a write that
  was interrupted between the chunk write and the record write.

The trade-off is that `chunkCount` and `chunkSize` are recorded on the row. A
`chunkSize` that no longer matches reality would corrupt reassembly, so the value
is stored per record rather than read from configuration at read time: changing
the default in a new release never breaks existing files.

---

## Why records carry denormalised columns

The row keeps lowercase copies of the searchable fields (`nameLower`,
`tagsLower`, `notesLower`, `textLower`, `metaText`), their union
(`searchText`), and a tokenised version (`searchTokens`).

An alternative is to compute those at query time, and a third option is a
separate inverted index. The denormalised columns won:

- IndexedDB cannot sort or compare case-insensitively, so `nameLower` is needed
  regardless for correct ordering.
- `searchText` makes ranking a handful of `indexOf` calls per candidate instead
  of rebuilding the same strings for every query.
- A separate inverted index would need its own store, its own write path and its
  own consistency story, for a feature that is already fast enough in memory.
- `search.fields` still works because each field keeps its own column, rather than
  one merged blob.

The cost is a modest increase in row size and one `buildSearchColumns()` call per
write, which is the right trade for a read-heavy, write-light workload.

Note that the denormalised `searchText` is capped: a huge extracted `text` field
is truncated in the search columns while `text` itself keeps the full value up to
`maxTextBytes`.

---

## Query pipeline

```
planIndex(where)                     pick one index and a key range
      |
      v
cursor over files                    yields candidate rows (no bytes)
      |
      v
matchesRecord(row, where)            every remaining clause as a predicate
      |
      v
scoreRecord(row, search)             rank, drop non-matches
      |
      v
sort                                 score first, then `sort`, then id
      |
      v
applyCursor -> slice(offset, limit)  the page
      |
      v
read chunks / thumbnails for the page only
```

Two properties fall out of this design.

**Index choice cannot change results.** Because `matchesRecord` always runs, a
pessimistic plan is slower, never wrong. That means the planner is free to be a
heuristic instead of a cost-based optimiser.

**Ordering is total.** `compareRecords` falls back to `id` when every sort field
ties, which makes cursor pagination stable across calls and across tabs.

The one nuance is tags. `by_tags` is a multi-entry index, so a cursor over
`only('trip')` finds records tagged `trip`. That is a sound narrowing for an
`all` list (any single member works) but not for an `any` list with several
alternatives, where indexing on one option would hide matches on the others.
`planIndex` accounts for this and only uses the tag index when it cannot lose
records.

---

## Transaction discipline

Every multi-step write runs inside one transaction, so a record, its chunks and
its thumbnail commit together. Three rules make that safe:

**Only IDB requests may be awaited inside a transaction.** A transaction stays
alive while it has pending requests and while their handlers are running.
Awaiting a timer, a `fetch` or a microtask that resolves outside that window lets
the browser commit early, after which further requests throw
`TransactionInactiveError`. Everything asynchronous that is *not* an IDB request
— hashing, text extraction, thumbnail generation — happens **before** the
transaction opens, in `#prepare()`.

**Completion is awaited explicitly.** `runTransaction()` attaches the completion
promise before running the body, catches an early rejection to avoid an unhandled
rejection warning, and after the body resolves it awaits the commit. A body that
throws aborts the transaction and rethrows.

**Reads stay read-only.** `accessedAt` is only bumped when `touch: true` is
passed. Otherwise a `get()` is a `readonly` transaction, so browsing a library
does not churn writes.

The public escape hatch, `db.transaction()`, hands you the same `wait` helper and
carries the same rule, which the API docs state plainly.

---

## Errors

`wrapIdbError()` translates platform failures into the library's hierarchy. It
matters for one case in particular: a browser at its storage limit raises a
`DOMException` whose `name` is `QuotaExceededError`, which surfaces as `QuotaError`
so callers can prompt the user to free space instead of showing a stack trace.

Because every library error extends `FileDBError`, a single `instanceof` check
distinguishes library failures from application ones. `NotFoundError` is used both
for missing records and for missing bytes, since from the caller's point of view
they are the same situation: the data is not there.

Listener exceptions are isolated. A broken `add` listener is logged and skipped so
that observing a write cannot fail the write.

---

## Concurrency and cross-tab behaviour

Each `FileDB` instance holds one connection and, by default, one
`BroadcastChannel` named `idb-file-store:<database>`.

- Local mutations emit their typed event, then a `change` event with
  `remote: false`, then post to the channel.
- Incoming messages are ignored when `source` matches the instance id, so a
  single tab does not echo its own writes.
- Remote changes only produce `change` events with `remote: true`. Listeners that
  mutate in response to `change` should check the flag to avoid loops.

Opening a database at a higher version than another tab holds open triggers
`onversionchange`; the library closes its connection and clears `isOpen` so a
subsequent call fails with `ClosedError` rather than operating on a dead handle.

---

## Migrations

`SCHEMA_VERSION` and `upgradeSchema(db, oldVersion)` in `storage/schema.ts` are the
single place schema changes belong.

```ts
export const SCHEMA_VERSION = 2;

export function upgradeSchema(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    createFilesStore(db);
    createChunksStore(db);
    createThumbnailsStore(db);
    createMetaStore(db);
  }
  if (oldVersion < 2) {
    // Additive steps only, for example a new index:
    db.transaction.objectStore(STORE_FILES).createIndex('by_rating', 'rating');
  }
}
```

Rules that keep upgrades safe:

- Steps are **additive and ordered**. A database created at version 1 must reach
  version 2 through the same code a fresh database runs from version 0.
- The callback runs inside `onupgradeneeded`, so it must only use the supplied
  transaction. It is synchronous by contract.
- Raising `FileDB({ version })` is a deliberate act. If any tab still holds an
  older connection, the upgrade blocks until it closes; `onBlocked` is where you
  surface that to the user.

---

## Deliberate non-goals

**Transactional commit protocols.** IndexedDB guarantees that a transaction
either commits or rolls back. Everything that fails can be attempted again; there
is no partial-write recovery to design.

**A server sync layer.** The library is local-first by design. Sync is an
application decision, and `snapshot()`, `backup()`, `change` events and `revision`
counters are the hooks for building it.

**Encryption at rest.** It would mean holding a key in the page, which offers no
protection against the threat it appears to address. Applications that need it
should encrypt before calling `add()` and treat the library as opaque storage.

**Multi-index query planning.** IndexedDB uses one index per cursor. Rather than
emulate intersects, the library leans on in-memory predicates, which is
predictable and correct.

**A file tree UI.** Folders are paths, not entities, which keeps the storage
model simple. The shape of the tree is a presentation concern: `facets().byFolder`
gives you the data to draw one, and `recipes.md` shows how.
