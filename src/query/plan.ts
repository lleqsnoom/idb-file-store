import { INDEX } from '../storage/schema.js';
import type { NumberOperators, OneOrMany, StringOperators, TimeFilter, Where } from '../types.js';
import { normalizeFolder } from '../utils/path.js';
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

/** Chooses the best available index for a `where` clause. */
export function planIndex(where: Where | undefined): IndexPlan {
  const filter: Where = where ?? {};

  if (typeof filter.id === 'string') {
    return { index: null, range: IDBKeyRange.only(filter.id), direction: 'next', empty: false };
  }

  const byName = namePlan(filter.name);
  if (byName) return byName;

  const byMime = stringPlan(filter.mime, INDEX.mime);
  if (byMime) return byMime;

  const byExtension = stringPlan(filter.extension, INDEX.extension);
  if (byExtension) return byExtension;

  const byHash = stringPlan(filter.hash, INDEX.hash);
  if (byHash) return byHash;

  const kind = firstOf(filter.kind);
  if (kind) return { index: INDEX.kind, range: IDBKeyRange.only(kind), direction: 'next', empty: false };

  const byFolder = folderPlan(filter.folder);
  if (byFolder) return byFolder;

  const byCreated = rangePlan(filter.createdAt, INDEX.createdAt);
  if (byCreated) return byCreated;

  const bySize = rangePlan(filter.size, INDEX.size);
  if (bySize) return bySize;

  const byUpdated = rangePlan(filter.updatedAt, INDEX.updatedAt);
  if (byUpdated) return byUpdated;

  const byAccessed = rangePlan(filter.accessedAt, INDEX.accessedAt);
  if (byAccessed) return byAccessed;

  const tag = firstTag(filter.tags);
  if (tag) return { index: INDEX.tags, range: IDBKeyRange.only(tag), direction: 'next', empty: false };

  if (filter.favorite !== undefined) {
    return {
      index: INDEX.favorite,
      range: IDBKeyRange.only(filter.favorite ? 1 : 0),
      direction: 'next',
      empty: false,
    };
  }

  // Every query defaults to live records only, so filtering out the trash through
  // an index beats scanning the whole store.
  if ((filter.deleted ?? false) === false) {
    return { index: INDEX.deletedAt, range: IDBKeyRange.only(0), direction: 'next', empty: false };
  }

  return FULL_SCAN;
}

function namePlan(filter: Where['name']): IndexPlan | null {
  if (filter === undefined) return null;
  if (typeof filter === 'string') {
    return exactPlan(INDEX.name, filter.toLowerCase());
  }
  if (Array.isArray(filter)) return null;
  const operators = filter as StringOperators;
  if (operators.eq !== undefined) return exactPlan(INDEX.name, operators.eq.toLowerCase());
  if (operators.startsWith !== undefined) {
    const prefix = operators.startsWith.toLowerCase();
    return {
      index: INDEX.name,
      range: IDBKeyRange.bound(prefix, `${prefix}${HIGH_CHAR}`, false, true),
      direction: 'next',
      empty: false,
    };
  }
  if (operators.in && operators.in.length === 1) {
    return exactPlan(INDEX.name, (operators.in[0] as string).toLowerCase());
  }
  return null;
}

function stringPlan(
  filter: OneOrMany<string> | StringOperators | undefined,
  index: string,
): IndexPlan | null {
  if (filter === undefined) return null;
  if (typeof filter === 'string') return exactPlan(index, filter.toLowerCase());
  if (Array.isArray(filter)) return null;
  const operators = filter as StringOperators;
  if (operators.eq !== undefined) return exactPlan(index, operators.eq.toLowerCase());
  if (operators.startsWith !== undefined) {
    const prefix = operators.startsWith.toLowerCase();
    return {
      index,
      range: IDBKeyRange.bound(prefix, `${prefix}${HIGH_CHAR}`, false, true),
      direction: 'next',
      empty: false,
    };
  }
  return null;
}

function folderPlan(filter: Where['folder']): IndexPlan | null {
  if (filter === undefined) return null;
  if (typeof filter === 'string') return exactPlan(INDEX.folder, normalizeFolder(filter));
  if (Array.isArray(filter)) return null;
  const operators = filter as Exclude<NonNullable<Where['folder']>, string | readonly string[]>;
  if (operators.eq !== undefined) return exactPlan(INDEX.folder, normalizeFolder(operators.eq));
  return null;
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
  if (!range) return null;
  return { index, range, direction: 'next', empty: false };
}

function toKeyRange(operators: NumberOperators): IDBKeyRange | null {
  if (operators.eq !== undefined) return IDBKeyRange.only(operators.eq);

  let lower: number | undefined;
  let lowerOpen = false;
  if (operators.gt !== undefined) {
    lower = operators.gt;
    lowerOpen = true;
  }
  if (operators.gte !== undefined && (lower === undefined || operators.gte > lower)) {
    lower = operators.gte;
    lowerOpen = false;
  }

  let upper: number | undefined;
  let upperOpen = false;
  if (operators.lt !== undefined) {
    upper = operators.lt;
    upperOpen = true;
  }
  if (operators.lte !== undefined && (upper === undefined || operators.lte < upper)) {
    upper = operators.lte;
    upperOpen = false;
  }

  if (operators.between) {
    const [min, max] = operators.between;
    if (lower === undefined || min > lower) {
      lower = min;
      lowerOpen = false;
    }
    if (upper === undefined || max < upper) {
      upper = max;
      upperOpen = false;
    }
  }

  if (lower === undefined && upper === undefined) return null;
  if (lower === undefined) return IDBKeyRange.upperBound(upper as number, upperOpen);
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
}

function exactPlan(index: string, value: string): IndexPlan {
  return { index, range: IDBKeyRange.only(value), direction: 'next', empty: false };
}

function firstOf(value: OneOrMany<string> | undefined): string | null {
  if (value === undefined) return null;
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