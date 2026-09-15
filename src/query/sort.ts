import type { Sort, SortField } from '../types.js';
import type { StoredFile } from '../storage/records.js';

/**
 * Sorting.
 *
 * IndexedDB can only order by a single index, and it compares strings
 * byte-wise, so `"File10"` would sort before `"File2"`. The library therefore
 * sorts in memory with an `Intl.Collator` configured for natural, case- and
 * accent-insensitive ordering, which is what a file browser should show.
 */

const TEXT_FIELDS: ReadonlySet<SortField> = new Set([
  'name',
  'kind',
  'mime',
  'extension',
  'folder',
]);

const DEFAULT_SORT: Sort = { by: 'createdAt', order: 'desc' };

let collator: Intl.Collator | null = null;

function getCollator(): Intl.Collator {
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return collator;
}

/** Normalises the many accepted `sort` shapes into a list of instructions. */
export function normalizeSorts(sort: Sort | readonly Sort[] | undefined): Sort[] {
  if (!sort) return [{ ...DEFAULT_SORT }];
  const list = Array.isArray(sort) ? sort : [sort as Sort];
  if (list.length === 0) return [{ ...DEFAULT_SORT }];
  return list.map((entry) => ({ by: entry.by, order: entry.order ?? 'asc' }));
}

/**
 * One accessor per sortable field.
 *
 * A `Record<SortField, ...>` rather than a `switch`: the compiler then rejects a
 * new {@link SortField} that has no accessor, and there is no unreachable default
 * branch to keep in step.
 */
const SORT_ACCESSORS: Record<SortField, (record: StoredFile) => string | number> = {
  name: (record) => record.nameLower,
  kind: (record) => record.kind,
  mime: (record) => record.mime,
  extension: (record) => record.extension,
  folder: (record) => record.folder,
  favorite: (record) => record.favorite,
  size: (record) => record.size,
  createdAt: (record) => record.createdAt,
  updatedAt: (record) => record.updatedAt,
  accessedAt: (record) => record.accessedAt,
  revision: (record) => record.revision,
};

/** Extracts the value used for ordering and for cursor keys. */
export function sortValue(record: StoredFile, field: SortField): string | number {
  return SORT_ACCESSORS[field](record);
}

/** Compares two records according to `sorts`, falling back to `id` for stability. */
export function compareRecords(a: StoredFile, b: StoredFile, sorts: readonly Sort[]): number {
  for (const sort of sorts) {
    const left = sortValue(a, sort.by);
    const right = sortValue(b, sort.by);
    const result = compareValues(left, right, sort.by);
    if (result !== 0) return sort.order === 'desc' ? -result : result;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareValues(left: string | number, right: string | number, field: SortField): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const leftText = String(left);
  const rightText = String(right);
  if (TEXT_FIELDS.has(field)) return getCollator().compare(leftText, rightText);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

/**
 * Compares a record against a decoded cursor key.
 *
 * @returns Negative when `record` comes before the cursor position.
 */
export function compareToCursor(
  record: StoredFile,
  key: readonly (string | number | null)[],
  sorts: readonly Sort[],
): number {
  for (let index = 0; index < sorts.length; index += 1) {
    const sort = sorts[index] as Sort;
    const cursorValue = key[index];
    if (cursorValue === null || cursorValue === undefined) continue;
    const result = compareValues(sortValue(record, sort.by), cursorValue, sort.by);
    if (result !== 0) return sort.order === 'desc' ? -result : result;
  }
  return 0;
}

/** Builds the cursor key array for a record. */
export function cursorKey(record: StoredFile, sorts: readonly Sort[]): (string | number)[] {
  return sorts.map((sort) => sortValue(record, sort.by));
}