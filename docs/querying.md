# Querying

Everything you can do with `db.list()`, `db.count()`, `db.iterate()`,
`db.facets()` and friends.

- [The query object](#the-query-object)
- [Filtering](#filtering)
  - [Strings](#strings)
  - [Numbers and sizes](#numbers-and-sizes)
  - [Timestamps](#timestamps)
  - [Folders](#folders)
  - [Tags](#tags)
  - [Metadata](#metadata)
  - [Custom predicates](#custom-predicates)
- [Sorting](#sorting)
- [Search](#search)
- [Pagination](#pagination)
- [Streaming](#streaming)
- [How a query is executed](#how-a-query-is-executed)
- [Performance](#performance)

---

## The query object

```ts
interface Query {
  where?: Where;
  search?: string | SearchQuery;
  sort?: Sort | Sort[];
  limit?: number;       // default 100
  offset?: number;      // default 0
  cursor?: string | null;
  includeBlob?: boolean;
  includeText?: boolean;
  includeThumbnail?: boolean;
}
```

Every field is optional. `db.list()` with no arguments returns the 100 most
recently created live records.

Filters combine with **AND**. Inside a clause, alternatives are expressed with a
list. There is no `OR` across clauses; use `where.custom` when you genuinely
need one, or issue two queries and merge.

Every query hides trashed records unless you set `where.deleted: true`.

---

## Filtering

### Strings

`name`, `mime` and `extension` accept a plain string, a list, or an operator
object. Text fields are matched case-insensitively.

```ts
{ name: 'report.pdf' }                                  // exact, case-insensitive
{ name: ['a.txt', 'b.txt'] }                            // any of
{ name: { contains: 'report' } }                        // substring
{ name: { startsWith: 'invoice-' } }                    // prefix
{ name: { endsWith: '.md' } }                           // suffix
{ name: { in: ['a.txt', 'b.txt'] } }                     // any of
{ name: { notIn: ['draft.md'] } }                        // none of
{ name: { ne: 'secret.txt' } }                           // not equal
{ name: { regex: /^IMG_\d+\.jpe?g$/i } }                 // arbitrary pattern
{ mime: { startsWith: 'video/' } }
```

`name.startsWith` and `name.eq` (and the same for `mime`, `extension`, `hash`,
`kind`, `folder`) are answered by an IndexedDB index. Everything else falls back
to a predicate after the indexed scan.

### Numbers and sizes

`size` takes an operator object.

```ts
{ size: { gte: 1024 } }
{ size: { gt: 0, lt: 1_000_000 } }
{ size: { between: [10_000, 5_000_000] } }   // inclusive
{ size: { ne: 0 } }
```

### Timestamps

`createdAt`, `updatedAt` and `accessedAt` accept a bare `Date`/number (exact
match) or the same operator object, with `Date` or epoch milliseconds.

```ts
{ createdAt: new Date('2024-01-01') }
{ createdAt: { gte: new Date('2024-01-01') } }
{ updatedAt: { between: [start, end] } }
```

Also useful: `accessedAt` lets you build a "recently opened" view when you pass
`{ touch: true }` to `get()`.

### Folders

Folders are flat strings that always start with `/`. Match one folder, several,
or a whole subtree.

```ts
{ folder: '/photos/2024' }
{ folder: ['/photos', '/videos'] }
{ folder: { startsWith: '/photos' } }   // '/photos' and everything below it
```

`startsWith` is a prefix match on the path, not on raw characters: `/photos-old`
is **not** inside `/photos`.

There are no folder entities to create or delete. To build a tree, group with
`facets().byFolder` or sort by `folder`.

### Tags

```ts
{ tags: ['trip', 'sunset'] }                     // must have ALL of them
{ tags: { all: ['trip'] } }                      // same thing, explicit
{ tags: { any: ['sunset', 'sunrise'] } }         // at least one
{ tags: { none: ['private'] } }                  // none of these
{ tags: { all: ['trip'], none: ['private'] } }   // combined
```

Tag comparison is case-insensitive; `Trip` and `trip` are the same tag for
filtering and de-duplication, while the first spelling you used is what gets
displayed.

### Metadata

Metadata is matched exactly, by dotted path, on the values you stored. A list
means "any of".

```ts
await db.add(file, { metadata: { camera: { make: 'Fujifilm', iso: 400 }, keywords: ['sunset'] } });

{ metadata: { 'camera.make': 'Fujifilm' } }
{ metadata: { 'camera.iso': 400 } }
{ metadata: { 'camera.iso': [200, 400, 800] } }
{ metadataContains: { 'camera.make': 'fuji' } }   // case-insensitive substring
```

Values must be JSON-safe: strings, finite numbers, booleans, `null`, arrays and
plain objects. `undefined`, functions, `NaN` and binary payloads are rejected at
write time with a message naming the offending path.

### Custom predicates

When the declarative surface is not enough, `where.custom` receives the whole
public record.

```ts
await db.list({
  where: {
    custom: (record) =>
      record.name.startsWith('IMG_') && record.width !== null && record.width > record.height,
  },
});
```

Predicates run after the indexed scan, so combine them with a cheap clause to
keep the candidate set small:

```ts
{ kind: 'image', custom: (r) => (r.width ?? 0) > (r.height ?? 0) }
```

---

## Sorting

```ts
{ sort: { by: 'size', order: 'desc' } }
{ sort: [{ by: 'favorite', order: 'desc' }, { by: 'name' }] }
```

Sortable fields: `name`, `size`, `createdAt`, `updatedAt`, `accessedAt`, `kind`,
`mime`, `extension`, `folder`, `favorite`, `revision`.

- Default is `{ by: 'createdAt', order: 'desc' }`.
- Later instructions are tie-breakers; `id` breaks any remaining tie, so ordering
  is total and pagination is stable.
- Text fields use `Intl.Collator` with `numeric: true` and `sensitivity: 'base'`.
  That means natural order (`IMG_2` before `IMG_10`) and case/accent-insensitive
  comparison, which is what a file browser should show.
- Sorting happens in memory after the candidates are collected; it cannot use an
  IndexedDB index. See [Performance](#performance).

---

## Search

```ts
db.list({ search: 'beach sunset' })
db.list({
  search: {
    text: 'beach sunset',
    fields: ['name', 'tags'],
    mode: 'all',
    fuzzy: true,
    boost: 2,
  },
});
```

`search` accepts a plain string (all defaults) or a `SearchQuery`. Hits come back
with a numeric `score` and are ranked highest first; when a search is active, the
`score` ordering takes precedence over `sort`, which then acts as the tie-breaker.

### Which fields are searched

By default: `name`, `text`, `notes`, `tags`, `folder`, `mime`, `metadata`.

- `text` is the text extracted from text-like payloads (`text/*`, JSON, XML,
  YAML, TOML, `+json`, `+xml`) up to `maxTextBytes`, or whatever you passed as
  `text`.
- `metadata` covers every primitive value in the metadata tree, including the
  keys themselves.

Restrict with `fields`. Restricting to `name` is a good way to build a
"search filenames only" toggle.

### Tokenisation

Text is normalised to lowercase, decomposed and stripped of diacritics, with a
handful of extra folds (`ł → l`, `ø → o`, `ß → ss`, `æ → ae`, and so on), then
split on punctuation and camelCase boundaries. So `Holiday-Photos_2024.jpeg`
becomes `holiday photos 2024 jpeg`, and searching `zazolc` finds `zażółć`.

### Ranking

Each token is matched against each searched field and keeps its **best** hit,
weighted by how meaningful the field is:

| Field | Weight |
| --- | --- |
| `name` | 12 |
| `tags` | 9 |
| `folder` | 5 |
| `notes` | 4 |
| `mime` | 3 |
| `text` | 2 |
| `metadata` | 2 |

Within a field, the quality of the match scales the weight:

| Match | Factor |
| --- | --- |
| Whole word (at a word boundary) | ×1.0 |
| Starts mid-word | ×0.6 |
| Fuzzy, one character off | ×0.35 |

Repeated occurrences of the same token in a field add up to `+0.15` each, capped
at three. When the query has more than one token and a field contains the whole
phrase, a flat `+6` bonus is added. Finally the total is multiplied by `boost`.

Practical consequences:

- A record named `beach.jpg` outranks a long document that merely mentions
  "beach".
- A tag hit beats a body-text hit.
- Multi-word queries reward records that contain the phrase.

### Modes and typos

- `mode: 'all'` (default) requires every token somewhere; `mode: 'any'` requires
  one.
- `fuzzy: true` accepts a token that is one edit away from a word in the field,
  for tokens of four or more characters. It is off by default because it widens
  result sets noticeably: `bech` matches `beach` in every record that mentions it.

`resolveSearch()` and `scoreRecord()` are exported, so you can reuse the same
ranking if you merge in results from somewhere else.

---

## Pagination

### Offset paging

```ts
const first = await db.list({ limit: 20, offset: 0 });
const second = await db.list({ limit: 20, offset: 20 });
```

Simple and stateless, and `total` is always the full match count. The catch is
that `offset` skips by rescanning: to return page 50 the library still collects
every match and slices. Fine for thousands of records, wasteful for hundreds of
thousands.

### Cursor paging

```ts
let cursor: string | null = null;
do {
  const page = await db.list({ limit: 20, cursor, sort: { by: 'createdAt', order: 'desc' } });
  render(page.items);
  cursor = page.nextCursor;
} while (cursor);
```

A cursor encodes the sort position of the last returned record plus its id, so
resuming skips straight past everything already seen. It is opaque base64url, safe
to keep in a URL or in component state, and it is stable because the sort order is
total.

Rules:

- The cursor must be produced by a query with the **same `sort`**. Reusing a
  cursor with a different sort is a bug; a malformed one throws `ValidationError`.
- When a cursor is present, `offset` is ignored.
- `total` is still the full match count, not the remainder.

`encodeCursor` and `decodeCursor` are exported if you need to inspect one.

---

## Streaming

`db.iterate()` walks matches without building a page:

```ts
for await (const record of db.iterate({ where: { kind: 'video' } })) {
  totals += record.size;
}
```

With a `sort`, records are collected first because ordering cannot be streamed.
Without one, primary keys are read up front and records are fetched in batches of
250, so memory stays flat no matter how large the library is.

Abort long walks with a signal:

```ts
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

for await (const record of db.iterate({ signal: controller.signal })) {
  await process(record);
}
```

---

## How a query is executed

1. **Plan.** The most selective `where` clause is turned into an `IDBKeyRange`
   against one of the indexes on `files`. If nothing can be narrowed, the scan
   falls back to the `deleted` index so trash is skipped.
2. **Scan.** Candidate rows are read — metadata only, never bytes.
3. **Filter.** The remaining clauses run as predicates, in memory. Trashed
   records are dropped here unless requested.
4. **Score.** If `search` is present, each surviving row is ranked; rows that fail
   the search are dropped.
5. **Order.** Rows are sorted by score (when searching) and then by `sort`.
6. **Page.** The cursor position is skipped, `limit` is applied, and extras
   (`blob`, `text`, `thumbnail`) are attached in a second transaction for just the
   page.

The index plan affects **speed only**. Because the predicates always run, an
unlucky plan costs time, never correctness.

`planIndex()` is exported so you can see the choice:

```ts
import { planIndex } from 'idb-file-store';

planIndex({ kind: 'image', tags: { any: ['a', 'b'] } });
// { index: 'by_kind', range: IDBKeyRange, direction: 'next', empty: false }
```

---

## Performance

**Filter on an indexed field.** These clauses are answered by an index: `id`,
`name: { eq | startsWith }`, `mime`, `extension`, `hash`, `kind`, `folder`,
timestamps, `size`, a single `tags` entry, `favorite`, and the default
`deleted: false`. Any of them turns a full scan into a narrow one.

**Watch the tag operations.** A `tags` array of length 1, or an `all` list, can
use the multi-entry tag index. An `any` list with several alternatives cannot, so
it falls back to a scan; include another indexed clause alongside it.

**Keep candidate sets sane.** Ordering and ranking are in-memory operations.
Everything is fast well into the tens of thousands of records because rows carry
no bytes, but if your library is larger, prefer `iterate()` for bulk work or pair
each query with a narrowing clause.

**Ask for fewer extras.** `includeBlob` reads chunks for every item on the page.
Fetch metadata first, then call `getBlob()` or `getObjectURL()` for what is
actually rendered.

**Reuse the planned index.** Sorting by `createdAt` while filtering on
`kind` means results are collected then re-sorted. Sorting by the same field you
filtered on does not help IndexedDB here (only one index drives the cursor), so
this is expected rather than a bug.
