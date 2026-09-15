# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Stopped writing two unused columns to every record. The merged search text and its
  tokenised copy were never read by the query engine, which reads the per-field
  columns instead. Measured on a 3,149-byte text file, the pair added 7,757 bytes to
  a row that is now 6,931 bytes: rows shrank from 4.7 to 2.2 times the payload. Rows
  written by earlier builds keep the two extra fields until rewritten, and nothing
  reads them. No migration is needed, because 0.1.0 has not been published.
- Corrected the documented browser floor to the versions `structuredClone` actually
  requires (Chrome/Edge 98, Firefox 94, Safari 15.4).
- Documented the index planner as a preference order rather than a cost model, which
  is what it is, in the README, the querying guide and `planIndex()`.

### Changed

- Extracted the numeric range rule into `query/bounds.ts`. The predicate pass and
  the index planner derived the tightest bounds independently, so they could have
  disagreed; they now share one implementation.
- Replaced `sortValue`'s switch with a `Record<SortField, accessor>` table, so a new
  sort field without an accessor is a compile error rather than a silent fallback.

### Fixed

- Reusing a `RegExp` with the `g` or `y` flag in a `where` clause no longer matches
  every other record, because the pattern's `lastIndex` is rewound before each test.
- `folder: { startsWith }` now plans an indexed range instead of scanning the whole
  store, while still excluding sibling folders such as `/photos-old`.
- `Page.limit` reports the limit that was applied, so an unbounded query returns a
  finite number instead of `Infinity`.
- Removed `ConflictError`, which was exported and documented but never thrown.

## [0.1.0] - 2026-09-15

First release.

### Added

- **Storage.** Chunked blob storage on IndexedDB with configurable chunk sizes,
  byte-range reads, and atomic writes covering a record, its chunks and its
  thumbnail in a single transaction.
- **CRUD API.** `add`, `addMany`, `importFiles`, `get`, `find`, `has`,
  `getBlob`, `readRange`, `getText`, `getThumbnail`, `update`, `updateMany`,
  `setTags`, `move`, `setFavorite`, `trash`, `restore`, `purge`, `emptyTrash`,
  `clear` and `pruneOrphans`.
- **Query API.** `list`, `all`, `first`, `count`, `search`, `iterate`, `facets`
  and `stats`, with declarative filters over kind, MIME type, extension, size,
  timestamps, folders, tags, favourites, trash state, content hash and nested
  metadata, plus a custom predicate escape hatch.
- **Sorting.** Multi-key ordering by name, size, timestamps, kind, MIME,
  extension, folder, favourite flag and revision, using natural,
  case-insensitive collation.
- **Search.** Field-weighted relevance ranking over names, tags, folders, notes,
  extracted text and metadata, with configurable fields, `all`/`any` modes,
  optional one-character typo tolerance and score boosting.
- **Pagination.** `limit`/`offset` and opaque, URL-safe cursors that resume
  without rescanning.
- **File handling.** Automatic MIME and kind detection, text extraction from
  text-like payloads, SHA-256 content hashing with a non-cryptographic fallback,
  optional de-duplication on write, and image preview generation.
- **Integrity and maintenance.** A trash with restore, orphan pruning, storage
  statistics including browser quota, JSON snapshots and full backups.
- **Reactivity.** Typed events for additions, updates, deletions, restores,
  purges and duplicates, mirrored to other tabs over `BroadcastChannel`.
- **Extras.** Object URLs with explicit revocation, browser downloads, `File`
  export and blob-to-bytes coercion helpers.
- **Documentation.** An API reference, a querying guide, task-oriented recipes
  and an architecture document, plus a vanilla-TypeScript playground app.
- **Tooling.** Strict TypeScript, ESM and CJS builds with type declarations,
  zero runtime dependencies, and 111 tests running on an in-memory IndexedDB.

[Unreleased]: https://github.com/lleqsnoom/idb-file-store/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lleqsnoom/idb-file-store/releases/tag/v0.1.0
