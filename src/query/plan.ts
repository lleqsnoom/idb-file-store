import { INDEX } from '../storage/schema.js';
import type { NumberOperators, OneOrMany, StringOperators, TimeFilter, Where } from '../types.js';
import { normalizeFolder } from '../utils/path.js';
import { tighterLower, tighterUpper } from './bounds.js';
import { normalizeTimeOperators } from './match.js';

/**
 * Index selection.
 *
 * IndexedDB can only use one index per cursor, so the planner picks the clause
 * that is likely to narrow the scan the most and converts it into an
 * `IDBKeyRange`. Everything else in the `where` clause is still applied as a
 * predicate afterwards, so the choice only affects speed, never correctness.
 */

/** The index (if any) and key range a scan should use. */
export interface IndexPlan {
  /** Index name, `null` for a primary-key or full scan. */
  index: string | null;
  /** Key range to scan, `null` for everything the index contains. */
  range: IDBKeyRange | null;
  /** Cursor direction, always ascending; ordering happens in memory. */
  direction: IDBCursorDirection;
  /** `true` when the filter can never match, so the scan can be skipped. */
  empty: boolean;
}

const FULL_SCAN: IndexPlan = { index: null, range: null, direction: 'next', empty: false };

/** Highest character in the BMP, used to build prefix ranges. */
const HIGH_CHAR = '\uffff';

/**
 * Chooses the best available index for a `where` clause.
 *
 * Selection is a documented preference order, not a cost model: the first clause
 * that can narrow the scan wins. That is enough because the predicate pass always
 * runs afterwards, so an unhelpful plan costs time but never correctness.
 */
export function planIndex(where: Where | undefined): IndexPlan {
  const filter: Where = where ?? {};
  return directPlan(filter) ?? indexPlan(filter) ?? fallbackPlan(filter);
}

/** Clauses addressed by the primary key, a name, a type or a hash. */
function directPlan(filter: Where): IndexPlan | null {
  return (
    idPlan(filter.id) ??
    stringOperatorPlan(filter.name, INDEX.name, lowerCase) ??
    stringOperatorPlan(filter.mime, INDEX.mime, lowerCase) ??
    stringOperatorPlan(filter.extension, INDEX.extension, lowerCase) ??
    stringOperatorPlan(filter.hash, INDEX.hash, lowerCase) ??
    singleValuePlan(filter.kind, INDEX.kind) ??
    stringOperatorPlan(filter.folder, INDEX.folder, normalizeFolder)
  );
}

/** Clauses addressed by a numeric index, plus the multi-entry tag index. */
function indexPlan(filter: Where): IndexPlan | null {
  return (
    rangePlan(filter.createdAt, INDEX.createdAt) ??
    rangePlan(filter.size, INDEX.size) ??
    rangePlan(filter.updatedAt, INDEX.updatedAt) ??
    rangePlan(filter.accessedAt, INDEX.accessedAt) ??
    singleValuePlan(firstTag(filter.tags), INDEX.tags)
  );
}

/** Clauses that are always available, so they are the last resort. */
function fallbackPlan(filter: Where): IndexPlan {
  if (filter.favorite !== undefined) {
    return ranged(INDEX.favorite, IDBKeyRange.only(filter.favorite ? 1 : 0));
  }
  // Every query defaults to live records only, so filtering out the trash through
  // an index beats scanning the whole store.
  if ((filter.deleted ?? false) === false) {
    return ranged(INDEX.deletedAt, IDBKeyRange.only(0));
  }
  return FULL_SCAN;
}

/**
 * Plans a scan of one index value, when the filter names exactly one.
 *
 * A list of alternatives cannot drive a single IndexedDB cursor, so those fall
 * through to the next clause and are resolved by the predicate pass instead.
 */
function singleValuePlan(value: OneOrMany<string> | null | undefined, index: string | null): IndexPlan | null {
  const only = firstOf(value);
  return only ? ranged(index, IDBKeyRange.only(only)) : null;
}

/** Ids live on the primary key, which is not an index. */
function idPlan(value: Where['id']): IndexPlan | null {
  return singleValuePlan(value, null);
}

/** An ascending scan of `range` on `index`; `null` means the primary key. */
function ranged(index: string | null, range: IDBKeyRange | null): IndexPlan {
  return { index, range, direction: 'next', empty: false };
}

/** How an index's keys are derived from a filter value. */
type KeyNormalizer = (value: string) => string;

const lowerCase = (value: string): string => value.toLowerCase();

/**
 * Plans a scan from a string filter: one value scans its own key, `startsWith`
 * scans the prefix range, and anything else falls through to the predicate pass.
 *
 * `normalize` must match the column the index is built on: the lowercased one for
 * name, MIME type, extension and hash, and the path-normalised one for folders,
 * whose index preserves case.
 */
function stringOperatorPlan(
  filter: OneOrMany<string> | StringOperators | undefined,
  index: string,
  normalize: KeyNormalizer,
): IndexPlan | null {
  if (filter === undefined) return null;
  if (typeof filter === 'string') return exactPlan(index, normalize(filter));
  if (Array.isArray(filter)) return null;

  const operators = filter as StringOperators;
  if (operators.eq !== undefined) return exactPlan(index, normalize(operators.eq));
  if (operators.startsWith !== undefined) return prefixPlan(index, normalize(operators.startsWith));
  // A one-entry `in` list names exactly one key, which is still a single-value scan.
  if (operators.in && operators.in.length === 1) {
    return exactPlan(index, normalize(operators.in[0] as string));
  }
  return null;
}

/**
 * Range covering every key that begins with `prefix`.
 *
 * The upper bound appends `\uffff` and is left open, which sorts above any
 * string starting with the prefix while excluding the sentinel itself.
 *
 * Callers pass the prefix already normalised for the index being scanned: an
 * index on a lowercase column needs a lowercased prefix, and the folder index
 * needs a normalised path, because it preserves case. A prefix range can admit
 * siblings such as `/photos-old` for `/photos`, so the predicate pass stays the
 * correctness guard either way.
 */
function prefixPlan(index: string, prefix: string): IndexPlan {
  return ranged(index, IDBKeyRange.bound(prefix, `${prefix}${HIGH_CHAR}`, false, true));
}

/**
 * Turns a timestamp or numeric filter into an index range.
 *
 * Accepts a bare `Date`/number (treated as `eq`), or any combination of
 * comparison operators. Date values are folded to epoch milliseconds so the
 * range compares against the stored numeric column.
 */
function rangePlan(filter: unknown, index: string): IndexPlan | null {
  if (filter === undefined) return null;

  let operators: NumberOperators | null = null;
  if (filter instanceof Date) operators = { eq: filter.getTime() };
  else if (typeof filter === 'number') operators = { eq: filter };
  else if (typeof filter === 'object' && filter !== null) {
    operators = normalizeTimeOperators(filter as Exclude<TimeFilter, Date | number>);
  }
  if (!operators) return null;

  const range = toKeyRange(operators);
  return range ? ranged(index, range) : null;
}

/**
 * Turns numeric operators into an index range.
 *
 * `between` and the comparison operators can be combined, so the tighter of each
 * pair wins: the highest lower bound and the lowest upper bound, with an open
 * bound beating an inclusive one at the same value.
 */
function toKeyRange(operators: NumberOperators): IDBKeyRange | null {
  if (operators.eq !== undefined) return IDBKeyRange.only(operators.eq);

  const lower = tighterLower(operators);
  const upper = tighterUpper(operators);

  if (!lower) return upper ? IDBKeyRange.upperBound(upper.value, upper.open) : null;
  if (!upper) return IDBKeyRange.lowerBound(lower.value, lower.open);
  return IDBKeyRange.bound(lower.value, upper.value, lower.open, upper.open);
}

function exactPlan(index: string, value: string): IndexPlan {
  return ranged(index, IDBKeyRange.only(value));
}

function firstOf(value: OneOrMany<string> | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return value.length === 1 ? (value[0] as string) : null;
}

/**
 * Picks a tag that can safely narrow a scan.
 *
 * The `by_tags` index is multi-entry, so any single tag from an `all` list is a
 * sound narrowing choice: a record that fails on that tag fails the filter too.
 * An `any` list is only usable when it holds exactly one alternative, because
 * indexing on one of several options would hide the records matching the others.
 */
function firstTag(filter: Where['tags']): string | null {
  if (filter === undefined) return null;
  if (Array.isArray(filter)) {
    return filter.length === 1 ? normalizeTag(filter[0] as string) : null;
  }
  const operators = filter as Exclude<NonNullable<Where['tags']>, readonly string[]>;
  const all = operators.all?.[0];
  if (typeof all === 'string') return normalizeTag(all);
  const any = operators.any?.length === 1 ? operators.any[0] : undefined;
  return typeof any === 'string' ? normalizeTag(any) : null;
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase();
}