# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  zero runtime dependencies, and 109 tests running on an in-memory IndexedDB.

[Unreleased]: https://github.com/lleqsnoom/idb-file-store/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lleqsnoom/idb-file-store/releases/tag/v0.1.0
