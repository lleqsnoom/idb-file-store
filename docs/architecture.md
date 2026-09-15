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
    prepare.ts                write pipeline: detect, hash, extract, preview, map

  query/
    match.ts                  where-clause predicates
    bounds.ts                 the numeric range rule, shared with the planner
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

The trade-off is that the row records `chunkCount` and `chunkSize`. A `chunkSize`
that no longer matches reality would corrupt reassembly, so each record stores its
own rather than reading configuration at read time: changing the default in a new
release never breaks existing files.

---

## Why records carry denormalised columns

The row keeps one lowercase column per searchable field: `nameLower`,
`tagsLower`, `notesLower`, `textLower` and `metaText`.

An alternative is to compute those at query time, and a third option is a
separate inverted index. The denormalised columns won:

- IndexedDB cannot sort or compare case-insensitively, so `nameLower` is needed
  regardless for correct ordering.
- A lowercase column turns ranking into a handful of `indexOf` calls per candidate,
  instead of rebuilding the same strings for every query.
- A separate inverted index would need its own store, its own write path and its
  own consistency story, for a feature that is fast enough in memory.
- `search.fields` works because each field keeps its own column, rather than one
  merged blob.

**Measured cost.** Storing a 3,149-byte text file produces 3,188 bytes of
denormalised columns, and the whole row is 6,931 bytes, so a text-heavy record
costs about 2.2 times its payload. Reproduce it with
`.x-skills/measure/row-size.mjs`, which reports the per-column breakdown.

An earlier design also stored a merged copy of every column (`searchText`) and a
tokenised array of it (`searchTokens`). Measurement showed those two accounted for
7,757 of those 3,149 payload bytes' worth of overhead, growing rows to 4.7 times
the payload, while **nothing read them**: the ranker reads the per-field columns
directly, and the default "search everywhere" path is just the full set of them.
Both were removed.

The `text` column is the exception to the sizing rule: extraction stops at
`maxTextBytes` (256 KiB by default), so indexing a large document stores a
truncated copy rather than the whole thing.

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

The predicate pass and the planner both need to know which range a numeric filter
implies, so `bounds.ts` derives it once: the tightest lower bound, the tightest
upper bound, and an open endpoint beating an inclusive one at the same value.
`plan.ts` turns those bounds into an `IDBKeyRange`, and `match.ts` tests a value
against them. One rule, two consumers, so a value a predicate accepts is always a
value the planned range can reach.

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

The library isolates listener exceptions: it logs a broken `add` listener and skips
it, so observing a write cannot fail the write.

---

## Concurrency and cross-tab behaviour

Each `FileDB` instance holds one connection and, by default, one
`BroadcastChannel` named `idb-file-store:<database>`.

- Local mutations emit their typed event, then a `change` event with
  `remote: false`, then post to the channel.
- The library ignores an incoming message whose `source` matches its own id, so a
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
either commits or rolls back. A caller can retry anything that fails; there is no
partial-write recovery to design.

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

---

## Guarantees and non-guarantees

What the library promises, and what it does not.

| Guarantee | Held by |
| --- | --- |
| A record, its chunks and its thumbnail commit or roll back together. | One transaction per write; the pipeline in `prepare.ts` runs before the transaction opens. |
| Ordering is total, so pagination is stable. | `compareRecords` falls back to `id` when every sort field ties. |
| `revision` increases on every write to a record. | `add()` starts at 1; `update()` and `#patch` increment it. |
| Filtering is correct whatever index the planner chooses. | The predicate pass always runs after the indexed scan. |
| Trashed records keep their bytes until purged. | `trash()` sets `deletedAt`; only `purge()` and `emptyTrash()` delete chunks. |

| Non-guarantee | Consequence |
| --- | --- |
| No cross-tab write serialisation. | Two tabs writing the same record both read, modify and put. The last commit wins and one update is lost. `change` events tell you it happened; they cannot prevent it. |
| `dedupe` cannot prevent a concurrent duplicate. | `add()` looks up the hash in a separate transaction from the insert, so two tabs adding the same payload at the same time store it twice. There is no unique index on `hash`. |
| No rollback for a bad migration. | `upgradeSchema` runs inside `onupgradeneeded`. Keep a backup with `backup()` or `snapshot()` before raising `version`. |
| No ordering guarantee for a search without `sort`. | Ranked results are ordered by score, and equal scores fall back to `sort`, then `id`. Two records with the same score can swap places unless you supply a `sort`. |

---

## Why not SQLite-WASM or OPFS?

The same problem has real alternatives, and they are the right answer in some
cases.

| | This library | SQLite-WASM + OPFS |
| --- | --- | --- |
| Payload | Plain JavaScript, no binary | A WASM build plus the app's own bundle |
| Threading | Works on any thread | Needs a worker to avoid blocking, and OPFS needs specific headers |
| Query language | A typed query object | SQL |
| Joins and aggregates | Not supported | Supported |
| Schema | Managed by `SCHEMA_VERSION` and additive steps | Managed by SQL migrations |
| Storage API | IndexedDB, available on every origin | OPFS, not available everywhere and restricted on some origins |

Reach for SQLite-WASM when you need joins, aggregates over millions of rows, or a
schema shared with a server database. Reach for this when you want a local file
library with search, filters and previews, without shipping a second runtime.

---

## References

Platform behaviour this design depends on, verified against the primary sources:

- IndexedDB key types (booleans, `null` and `undefined` are not keys) and the rule
  that a record whose indexed value is not a key is stored but omitted from that
  index: <https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology>
- Transaction lifetime ("If you return to the event loop without using it then the
  transaction will become inactive"): <https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB>
- `structuredClone` support, which sets the browser floor:
  <https://developer.mozilla.org/en-US/docs/Web/API/structuredClone>
- `BroadcastChannel` and `createImageBitmap` support, which set the floors for the
  optional features: <https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel>,
  <https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap>
- `OffscreenCanvas` support, which decides whether preview rendering needs a DOM:
  <https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas>
