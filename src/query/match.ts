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
import { toPublicRecord } from '../utils/record.js';
import { normalizeText } from '../utils/text.js';

/** Tests a string field against a string filter. */
export function matchesString(value: string, filter: OneOrMany<string> | StringOperators): boolean {
  if (typeof filter === 'string') return value.toLowerCase() === filter.toLowerCase();
  if (Array.isArray(filter)) {
    const lowered = value.toLowerCase();
    return (filter as readonly string[]).some((candidate) => candidate.toLowerCase() === lowered);
  }

  const operators = filter as StringOperators;
  const lowered = value.toLowerCase();
  if (operators.eq !== undefined && lowered !== operators.eq.toLowerCase()) return false;
  if (operators.ne !== undefined && lowered === operators.ne.toLowerCase()) return false;
  if (operators.contains !== undefined && !lowered.includes(operators.contains.toLowerCase())) {
    return false;
  }
  if (
    operators.startsWith !== undefined &&
    !lowered.startsWith(operators.startsWith.toLowerCase())
  ) {
    return false;
  }
  if (operators.endsWith !== undefined && !lowered.endsWith(operators.endsWith.toLowerCase())) {
    return false;
  }
  if (operators.in && !operators.in.some((candidate) => candidate.toLowerCase() === lowered)) {
    return false;
  }
  if (operators.notIn?.some((candidate) => candidate.toLowerCase() === lowered)) return false;
  if (operators.regex && !operators.regex.test(value)) return false;
  return true;
}

/** Tests a numeric field against a number filter. */
export function matchesNumber(value: number, filter: NumberOperators): boolean {
  if (filter.eq !== undefined && value !== filter.eq) return false;
  if (filter.ne !== undefined && value === filter.ne) return false;
  if (filter.gt !== undefined && !(value > filter.gt)) return false;
  if (filter.gte !== undefined && !(value >= filter.gte)) return false;
  if (filter.lt !== undefined && !(value < filter.lt)) return false;
  if (filter.lte !== undefined && !(value <= filter.lte)) return false;
  if (filter.between) {
    const [min, max] = filter.between;
    if (value < min || value > max) return false;
  }
  return true;
}

/** Tests a timestamp field against a filter that accepts `Date` or milliseconds. */
export function matchesTime(value: number, filter: TimeFilter): boolean {
  if (filter instanceof Date) return value === filter.getTime();
  if (typeof filter === 'number') return value === filter;
  return matchesNumber(value, normalizeTimeOperators(filter));
}

/** Converts a `Date`-bearing operator object into a plain numeric one. */
export function normalizeTimeOperators(
  filter: Exclude<TimeFilter, Date | number>,
): NumberOperators {
  const at = (value: Date | number | undefined): number | undefined =>
    value === undefined ? undefined : value instanceof Date ? value.getTime() : value;

  const out: NumberOperators = {};
  const eq = at(filter.eq);
  if (eq !== undefined) out.eq = eq;
  const ne = at(filter.ne);
  if (ne !== undefined) out.ne = ne;
  const gt = at(filter.gt);
  if (gt !== undefined) out.gt = gt;
  const gte = at(filter.gte);
  if (gte !== undefined) out.gte = gte;
  const lt = at(filter.lt);
  if (lt !== undefined) out.lt = lt;
  const lte = at(filter.lte);
  if (lte !== undefined) out.lte = lte;
  if (filter.between) {
    out.between = [at(filter.between[0]) as number, at(filter.between[1]) as number];
  }
  return out;
}

/** Tests a tag list against a tag filter. */
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

/** Tests a folder path against a folder filter. */
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

/** Deep JSON equality, used by metadata filters. */
export function deepEqualJson(a: unknown, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, JsonValue>;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => key in right && deepEqualJson(left[key], right[key]));
  }
  return false;
}

/** Evaluates a whole `where` clause against a stored record. */
export function matchesRecord(record: StoredFile, where: Where | undefined): boolean {
  // An absent filter still means "live records only", so normalise it to `{}`
  // rather than treating it as "match everything".
  const filter: Where = where ?? {};

  if (filter.id !== undefined && !matchesScalarList(record.id, filter.id)) return false;
  if (filter.name !== undefined && !matchesString(record.name, filter.name)) return false;
  if (filter.kind !== undefined && !matchesScalarList(record.kind, filter.kind)) return false;
  if (filter.mime !== undefined && !matchesString(record.mime, filter.mime)) return false;
  if (filter.extension !== undefined && !matchesString(record.extension, filter.extension)) {
    return false;
  }
  if (filter.size !== undefined && !matchesNumber(record.size, filter.size)) return false;
  if (filter.createdAt !== undefined && !matchesTime(record.createdAt, filter.createdAt)) return false;
  if (filter.updatedAt !== undefined && !matchesTime(record.updatedAt, filter.updatedAt)) return false;
  if (filter.accessedAt !== undefined && !matchesTime(record.accessedAt, filter.accessedAt)) {
    return false;
  }
  if (filter.folder !== undefined && !matchesFolder(record.folder, filter.folder)) return false;
  if (filter.tags !== undefined && !matchesTags(record.tags, filter.tags)) return false;
  if (filter.favorite !== undefined && (record.favorite === 1) !== filter.favorite) return false;
  if ((record.deletedAt > 0) !== (filter.deleted ?? false)) return false;
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