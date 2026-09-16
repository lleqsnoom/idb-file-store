import type { SearchField, SearchQuery } from '../types.js';
import type { StoredFile } from '../storage/records.js';
import {
  boundedLevenshtein,
  countOccurrences,
  matchTokens,
  normalizeText,
  tokenize,
} from '../utils/text.js';

/**
 * Full-text search and relevance scoring.
 *
 * The index is a set of denormalised lowercase columns on each row, so scoring
 * is a handful of `indexOf` calls per candidate: fast enough to run over tens of
 * thousands of records in a page load, and it needs no extra object store.
 *
 * Scoring walks every search token and keeps its best per-field match, weighted
 * by how meaningful the field is. A word-boundary hit scores full marks, a
 * mid-word hit scores less, and (optionally) a one-character typo scores least.
 */

/** A search query with its defaults resolved. */
export interface ResolvedSearch {
  /** Tokens to look for, already normalised. */
  tokens: string[];
  /** Fields allowed to match. */
  fields: readonly SearchField[];
  /** `all` requires every token, `any` requires one. */
  mode: 'all' | 'any';
  /** Whether one-character typos count as a match. */
  fuzzy: boolean;
  /** Multiplier applied to the final score. */
  boost: number;
  /** Normalised whole query, used for the phrase bonus. */
  phrase: string;
}

/** Every field search looks at by default. */
export const DEFAULT_SEARCH_FIELDS: readonly SearchField[] = [
  'name',
  'tags',
  'folder',
  'mime',
  'notes',
  'text',
  'metadata',
];

/** How much a match in each field is worth. */
const FIELD_WEIGHTS: Record<SearchField, number> = {
  name: 12,
  tags: 9,
  folder: 5,
  notes: 4,
  mime: 3,
  text: 2,
  metadata: 2,
};

const FUZZY_MIN_LENGTH = 4;
const PHRASE_BONUS = 6;

/** What each kind of token hit is worth, before field weighting. */
const WORD_START_SCORE = 1;
const MID_WORD_SCORE = 0.6;
const FUZZY_SCORE = 0.35;
/** Added per extra occurrence of a token, for the first three repeats. */
const REPEAT_STEP = 0.15;
const MAX_COUNTED_REPEATS = 3;

/** Resolves a search input into a {@link ResolvedSearch}, or `null` when empty. */
export function resolveSearch(search: string | SearchQuery | undefined): ResolvedSearch | null {
  if (search === undefined) return null;
  const query: SearchQuery = typeof search === 'string' ? { text: search } : search;
  const tokens = tokenize(query.text);
  if (tokens.length === 0) return null;

  return {
    tokens,
    fields: query.fields && query.fields.length > 0 ? [...query.fields] : DEFAULT_SEARCH_FIELDS,
    mode: query.mode ?? 'all',
    fuzzy: query.fuzzy ?? false,
    boost: query.boost ?? 1,
    phrase: normalizeText(query.text),
  };
}

/**
 * Scores a record against a resolved search.
 *
 * @returns The relevance score, or `null` when the record does not match.
 */
export function scoreRecord(record: StoredFile, search: ResolvedSearch): number | null {
  const texts = collectFieldTexts(record, search.fields);
  let total = 0;
  let matched = 0;

  for (const token of search.tokens) {
    const best = bestFieldScore(texts, token, search.fuzzy);
    if (best === 0) {
      if (search.mode === 'all') return null;
      continue;
    }
    matched += 1;
    total += best;
  }

  if (matched === 0) return null;
  return (total + phraseBonus(texts, search)) * search.boost;
}

/** Highest weighted score the token reaches in any of the searched fields. */
function bestFieldScore(
  texts: ReadonlyArray<[SearchField, string]>,
  token: string,
  fuzzy: boolean,
): number {
  let best = 0;
  for (const [field, text] of texts) {
    if (!text) continue;
    const weight = FIELD_WEIGHTS[field];
    if (weight === 0) continue;
    const weighted = weight * tokenScore(text, token, fuzzy);
    if (weighted > best) best = weighted;
  }
  return best;
}

/** Flat bonus when a multi-token query appears whole inside one field. */
function phraseBonus(texts: ReadonlyArray<[SearchField, string]>, search: ResolvedSearch): number {
  if (search.tokens.length < 2 || !search.phrase) return 0;
  return texts.some(([, text]) => text.includes(search.phrase)) ? PHRASE_BONUS : 0;
}

/** Collects the lowercase column for each requested field, skipping empties. */
function collectFieldTexts(
  record: StoredFile,
  fields: readonly SearchField[],
): Array<[SearchField, string]> {
  const out: Array<[SearchField, string]> = [];
  for (const field of fields) {
    const text = fieldText(record, field);
    if (text) out.push([field, text]);
  }
  return out;
}

function fieldText(record: StoredFile, field: SearchField): string {
  switch (field) {
    case 'name':
      return record.nameLower;
    case 'tags':
      return record.tagsLower;
    case 'folder':
      return record.folder.toLowerCase();
    case 'mime':
      return record.mime;
    case 'notes':
      return record.notesLower;
    case 'text':
      return record.textLower;
    case 'metadata':
      return record.metaText;
    default:
      return '';
  }
}

/**
 * Score of a single token inside one field: `1` for a word-boundary hit, less
 * for a mid-word hit, less again for a fuzzy hit. `0` means no match.
 */
function tokenScore(text: string, token: string, fuzzy: boolean): number {
  const index = text.indexOf(token);
  if (index !== -1) {
    const previous = index === 0 ? ' ' : text[index - 1];
    const atWordStart = previous === undefined || !/[a-z0-9]/.test(previous);
    const occurrences = countOccurrences(text, token);
    const repetition = Math.min(occurrences - 1, MAX_COUNTED_REPEATS) * REPEAT_STEP;
    return (atWordStart ? WORD_START_SCORE : MID_WORD_SCORE) + repetition;
  }

  if (!fuzzy || token.length < FUZZY_MIN_LENGTH) return 0;
  for (const candidate of matchTokens(text)) {
    if (candidate.length < FUZZY_MIN_LENGTH) continue;
    if (boundedLevenshtein(candidate, token, 1) <= 1) return FUZZY_SCORE;
  }
  return 0;
}

/**
 * `true` when the record would match the search, without computing a score.
 * Cheaper than {@link scoreRecord} when you only need a boolean.
 */
export function matchesSearch(record: StoredFile, search: ResolvedSearch): boolean {
  if (search.mode === 'all' && search.tokens.length > 1) {
    return scoreRecord(record, search) !== null;
  }
  const texts = collectFieldTexts(record, search.fields);
  for (const token of search.tokens) {
    for (const [, text] of texts) {
      if (tokenScore(text, token, search.fuzzy) > 0) return true;
    }
  }
  return false;
}