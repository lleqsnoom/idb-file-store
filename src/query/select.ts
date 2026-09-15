import { ValidationError } from '../errors.js';
import type { Query, Sort } from '../types.js';
import type { StoredFile } from '../storage/records.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { matchesRecord } from './match.js';
import { resolveSearch, scoreRecord } from './search.js';
import { compareRecords, compareToCursor, cursorKey, normalizeSorts } from './sort.js';

/**
 * In-memory selection: filter, search, order, page.
 *
 * Records are read from IndexedDB as metadata-only rows (no bytes), so a few
 * tens of thousands of them fit comfortably in memory. That lets the library
 * offer ordering and relevance ranking that IndexedDB cannot express natively,
 * at the cost of reading the candidate set. Use `where` to keep that set small,
 * or {@link FileDB.iterate} to stream instead of collecting.
 */

/** Default page size when a query does not set `limit`. */
export const DEFAULT_LIMIT = 100;

/** A record together with its relevance score, when a search was applied. */
export interface SelectedRow {
  /** The stored row. */
  row: StoredFile;
  /** Relevance score, or `null` when the query had no `search`. */
  score: number | null;
}

/** The outcome of applying a query to a candidate set. */
export interface Selection {
  /** The page of rows, already ordered and sliced. */
  rows: SelectedRow[];
  /** Number of rows matching the query, before `limit`/`offset`/`cursor`. */
  total: number;
  /** Cursor pointing past the last returned row, or `null` at the end. */
  nextCursor: string | null;
  /** Sort instructions that were applied, useful for cursor round trips. */
  sorts: Sort[];
}

/** Applies `query` to an already-filtered-by-index candidate set. */
export function selectRecords(candidates: readonly StoredFile[], query: Query): Selection {
  const search = resolveSearch(query.search);
  const sorts = normalizeSorts(query.sort);

  const scored: SelectedRow[] = [];
  for (const row of candidates) {
    if (!matchesRecord(row, query.where)) continue;
    const score = search ? scoreRecord(row, search) : null;
    if (search && score === null) continue;
    scored.push({ row, score });
  }

  scored.sort((a, b) => {
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
    return compareRecords(a.row, b.row, sorts);
  });

  const total = scored.length;
  const limited = applyCursor(scored, query, sorts);
  const offset = normalizeOffset(query.offset);
  const limit = normalizeLimit(query.limit);
  const page = limited.slice(offset, offset + limit);
  const consumed = offset + page.length;
  const hasMore = consumed < limited.length;

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1] as SelectedRow;
    nextCursor = encodeCursor(cursorKey(last.row, sorts), last.row.id);
  }

  return { rows: page, total, nextCursor, sorts };
}

/** Drops everything at or before the cursor position. */
function applyCursor(rows: SelectedRow[], query: Query, sorts: Sort[]): SelectedRow[] {
  if (!query.cursor) return rows;
  const payload = decodeCursor(query.cursor);
  return rows.filter((entry) => {
    const comparison = compareToCursor(entry.row, payload.k, sorts);
    if (comparison !== 0) return comparison > 0;
    return entry.row.id > payload.id;
  });
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(limit) || limit < 0) {
    throw new ValidationError(`limit must be a non-negative number, received ${String(limit)}`);
  }
  return Math.floor(limit);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset) || offset < 0) {
    throw new ValidationError(`offset must be a non-negative number, received ${String(offset)}`);
  }
  return Math.floor(offset);
}

/** Counts rows matching a query without materialising a page. */
export function countRecords(candidates: readonly StoredFile[], query: Query): number {
  return selectRecords(candidates, { ...query, limit: 1, offset: 0, cursor: null }).total;
}