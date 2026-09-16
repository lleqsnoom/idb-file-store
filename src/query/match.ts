/**
 * Filter evaluation.
 *
 * Every `where` clause becomes a predicate over a stored record. When a clause
 * can also be answered by an IndexedDB index, the planner prefers that so a scan
 * starts from a narrow range instead of the whole store; the predicate still runs
 * afterwards, which keeps results correct regardless of which index was chosen.
 */

import type {
  FolderFilter,
  JsonValue,
  NumberOperators,
  OneOrMany,
  StringOperators,
  TagFilter,
  TimeFilter,
  Where,
} from '../types.js';
import type { StoredFile } from '../storage/records.js';
import { getByPath, isInsideFolder, normalizeFolder } from '../utils/path.js';
import { satisfiesBounds, tighterLower, tighterUpper } from './bounds.js';
import { toPublicRecord } from '../utils/record.js';
import { normalizeText } from '../utils/text.js';

export function matchesString(value: string, filter: OneOrMany<string> | StringOperators): boolean {
  if (typeof filter === 'string' || Array.isArray(filter)) {
    return matchesLiteral(value, filter as string | readonly string[]);
  }

  const operators = filter as StringOperators;
  const lowered = value.toLowerCase();
  return matchesEquality(lowered, operators) && matchesShape(value, lowered, operators);
}

/** Matches against one literal or a list of them, ignoring case. */
function matchesLiteral(value: string, filter: string | readonly string[]): boolean {
  const lowered = value.toLowerCase();
  const candidates = typeof filter === 'string' ? [filter] : filter;
  return candidates.some((candidate) => candidate.toLowerCase() === lowered);
}

/** `eq`, `ne`, `in` and `notIn` ask whether the value is one of a set. */
function matchesEquality(lowered: string, operators: StringOperators): boolean {
  const equals = (candidate: string): boolean => candidate.toLowerCase() === lowered;

  if (operators.eq !== undefined && !equals(operators.eq)) return false;
  if (operators.ne !== undefined && equals(operators.ne)) return false;
  if (operators.in && !operators.in.some(equals)) return false;
  if (operators.notIn?.some(equals)) return false;
  return true;
}

/** `contains`, `startsWith`, `endsWith` and `regex` ask about the value's shape. */
function matchesShape(raw: string, lowered: string, operators: StringOperators): boolean {
  const has = (needle: string | undefined): boolean =>
    needle === undefined || lowered.includes(needle.toLowerCase());
  const starts = (needle: string | undefined): boolean =>
    needle === undefined || lowered.startsWith(needle.toLowerCase());
  const ends = (needle: string | undefined): boolean =>
    needle === undefined || lowered.endsWith(needle.toLowerCase());

  return (
    has(operators.contains) &&
    starts(operators.startsWith) &&
    ends(operators.endsWith) &&
    (!operators.regex || testPattern(operators.regex, raw))
  );
}

export function matchesNumber(value: number, filter: NumberOperators): boolean {
  return matchesExactNumber(value, filter) && matchesNumberBounds(value, filter);
}

/** `eq` and `ne` compare against one number. */
function matchesExactNumber(value: number, filter: NumberOperators): boolean {
  if (filter.eq !== undefined && value !== filter.eq) return false;
  if (filter.ne !== undefined && value === filter.ne) return false;
  return true;
}

/** `gt`, `gte`, `lt`, `lte` and `between` place the value in a range. */
function matchesNumberBounds(value: number, filter: NumberOperators): boolean {
  return satisfiesBounds(value, tighterLower(filter), tighterUpper(filter));
}

/** Accepts a `Date`, epoch milliseconds, or the same comparison operators as a number. */
export function matchesTime(value: number, filter: TimeFilter): boolean {
  if (filter instanceof Date) return value === filter.getTime();
  if (typeof filter === 'number') return value === filter;
  return matchesNumber(value, normalizeTimeOperators(filter));
}

/** Numeric operators that carry exactly one value. */
const SINGLE_VALUE_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;

/** Converts a `Date`-bearing operator object into a plain numeric one. */
export function normalizeTimeOperators(
  filter: Exclude<TimeFilter, Date | number>,
): NumberOperators {
  const at = (value: Date | number | undefined): number | undefined =>
    value === undefined ? undefined : value instanceof Date ? value.getTime() : value;

  const out: NumberOperators = {};
  for (const operator of SINGLE_VALUE_OPERATORS) {
    const value = at(filter[operator]);
    if (value !== undefined) out[operator] = value;
  }
  if (filter.between) {
    out.between = [at(filter.between[0]) as number, at(filter.between[1]) as number];
  }
  return out;
}

export function matchesTags(tags: readonly string[], filter: TagFilter): boolean {
  const lowered = tags.map((tag) => tag.toLowerCase());
  const has = (tag: string): boolean => lowered.includes(tag.toLowerCase());

  if (Array.isArray(filter)) return (filter as readonly string[]).every(has);

  const operators = filter as Exclude<TagFilter, readonly string[]>;
  if (operators.all && !operators.all.every(has)) return false;
  if (operators.any && operators.any.length > 0 && !operators.any.some(has)) return false;
  if (operators.none?.some(has)) return false;
  return true;
}

export function matchesFolder(folder: string, filter: FolderFilter): boolean {
  if (typeof filter === 'string') return folder === normalizeFolder(filter);
  if (Array.isArray(filter)) {
    return (filter as readonly string[]).some((candidate) => folder === normalizeFolder(candidate));
  }
  const operators = filter as Exclude<FolderFilter, string | readonly string[]>;
  if (operators.eq !== undefined && folder !== normalizeFolder(operators.eq)) return false;
  if (operators.startsWith !== undefined && !isInsideFolder(folder, operators.startsWith)) {
    return false;
  }
  return true;
}

/**
 * Runs a caller-supplied pattern without letting it keep state.
 *
 * A `RegExp` carrying the `g` or `y` flag remembers `lastIndex` between calls, so
 * testing the same object against successive records would match every other one.
 * Rewinding the index first is the documented way to reuse such a pattern.
 */
export function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * Deep JSON equality, used by metadata filters.
 *
 * Arrays and plain objects are compared as their own kinds: an array never equals
 * an object with the same entries, which a structural comparison would accept.
 */
export function deepEqualJson(a: unknown, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return equalArrays(a, b);
  if (isJsonObject(a) && isJsonObject(b)) return equalObjects(a, b);
  return false;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalArrays(a: readonly unknown[], b: readonly JsonValue[]): boolean {
  return a.length === b.length && a.every((item, index) => deepEqualJson(item, b[index]));
}

function equalObjects(a: Record<string, unknown>, b: Record<string, JsonValue>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && deepEqualJson(a[key], b[key]));
}

/**
 * Evaluates a whole `where` clause against a stored record.
 *
 * The groups below are split by subject rather than by field order, so a failing
 * group points at the kind of filter that rejected the record, and each group can
 * be exercised on its own.
 */
export function matchesRecord(record: StoredFile, where: Where | undefined): boolean {
  // An absent filter still means "live records only", so normalise it to `{}`
  // rather than treating it as "match everything".
  const filter: Where = where ?? {};
  return (
    matchesIdentity(record, filter) &&
    matchesType(record, filter) &&
    matchesSize(record, filter) &&
    matchesDates(record, filter) &&
    matchesPlacement(record, filter) &&
    matchesFlags(record, filter) &&
    matchesContent(record, filter)
  );
}

/** Id and display name. */
function matchesIdentity(record: StoredFile, filter: Where): boolean {
  if (filter.id !== undefined && !matchesScalarList(record.id, filter.id)) return false;
  if (filter.name !== undefined && !matchesString(record.name, filter.name)) return false;
  return true;
}

/** Kind, MIME type and extension. */
function matchesType(record: StoredFile, filter: Where): boolean {
  if (filter.kind !== undefined && !matchesScalarList(record.kind, filter.kind)) return false;
  if (filter.mime !== undefined && !matchesString(record.mime, filter.mime)) return false;
  if (filter.extension !== undefined && !matchesString(record.extension, filter.extension)) {
    return false;
  }
  return true;
}

function matchesSize(record: StoredFile, filter: Where): boolean {
  return filter.size === undefined || matchesNumber(record.size, filter.size);
}

/** Creation, modification and last-read times. */
function matchesDates(record: StoredFile, filter: Where): boolean {
  if (filter.createdAt !== undefined && !matchesTime(record.createdAt, filter.createdAt)) {
    return false;
  }
  if (filter.updatedAt !== undefined && !matchesTime(record.updatedAt, filter.updatedAt)) {
    return false;
  }
  if (filter.accessedAt !== undefined && !matchesTime(record.accessedAt, filter.accessedAt)) {
    return false;
  }
  return true;
}

/** Folder path and tags. */
function matchesPlacement(record: StoredFile, filter: Where): boolean {
  if (filter.folder !== undefined && !matchesFolder(record.folder, filter.folder)) return false;
  if (filter.tags !== undefined && !matchesTags(record.tags, filter.tags)) return false;
  return true;
}

/** Favourite flag and trash state. */
function matchesFlags(record: StoredFile, filter: Where): boolean {
  if (filter.favorite !== undefined && (record.favorite === 1) !== filter.favorite) return false;
  if ((record.deletedAt > 0) !== (filter.deleted ?? false)) return false;
  return true;
}

/** Hash, metadata and the caller's own predicate. */
function matchesContent(record: StoredFile, filter: Where): boolean {
  if (filter.hash !== undefined && !matchesScalarList(record.hash ?? '', filter.hash)) return false;
  if (filter.metadata && !matchesMetadata(record.metadata, filter.metadata)) return false;
  if (filter.metadataContains && !matchesMetadataContains(record.metadata, filter.metadataContains)) {
    return false;
  }
  if (filter.custom && !filter.custom(toPublicRecord(record))) return false;
  return true;
}

function matchesScalarList(value: string, filter: OneOrMany<string>): boolean {
  return typeof filter === 'string' ? value === filter : (filter as readonly string[]).includes(value);
}

function matchesMetadata(
  metadata: Record<string, JsonValue>,
  expected: Record<string, JsonValue>,
): boolean {
  for (const [path, value] of Object.entries(expected)) {
    const actual = getByPath(metadata, path);
    if (Array.isArray(value)) {
      const list = value as JsonValue[];
      if (!list.some((candidate) => deepEqualJson(actual, candidate))) return false;
      continue;
    }
    if (!deepEqualJson(actual, value)) return false;
  }
  return true;
}

function matchesMetadataContains(
  metadata: Record<string, JsonValue>,
  expected: Record<string, string>,
): boolean {
  for (const [path, needle] of Object.entries(expected)) {
    const actual = getByPath(metadata, path);
    if (actual === undefined || actual === null) return false;
    if (!normalizeText(stringify(actual as JsonValue)).includes(normalizeText(needle))) return false;
  }
  return true;
}

function stringify(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
