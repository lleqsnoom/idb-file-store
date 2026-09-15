/**
 * Text utilities: normalisation, tokenisation and a bounded edit distance used
 * by the fuzzy search mode.
 */

const DIACRITICS = /[\u0300-\u036f]/g;

/**
 * Characters that Unicode decomposition leaves alone but that users expect to
 * match their ASCII spelling, so `zazolc` finds `zażółć`.
 */
const SPECIAL_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/[łĺľļ]/g, 'l'],
  [/[øöò]/g, 'o'],
  [/[đďð]/g, 'd'],
  [/[þ]/g, 'th'],
  [/[ß]/g, 'ss'],
  [/[æ]/g, 'ae'],
  [/[œ]/g, 'oe'],
  [/[ı]/g, 'i'],
];
const SPLIT_PATTERN = /[^\p{L}\p{N}]+/u;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function foldSpecialCharacters(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SPECIAL_FOLDS) out = out.replace(pattern, replacement);
  return out;
}

/** Lowercases, strips diacritics and collapses whitespace. */
export function normalizeText(input: string): string {
  return foldSpecialCharacters(input.normalize('NFD').replace(DIACRITICS, '').toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits text into searchable tokens. Handles punctuation, camelCase and
 * non-Latin scripts, and drops single characters that carry no signal.
 */
export function tokenize(input: string): string[] {
  const normalized = normalizeText(input.replace(CAMEL_BOUNDARY, '$1 $2'));
  if (!normalized) return [];
  return normalized.split(SPLIT_PATTERN).filter((token) => token.length > 0);
}

/**
 * Extracts every token from a string, including single characters. Used for
 * fuzzy candidate generation, so it applies the same folding as
 * {@link normalizeText}.
 */
export function matchTokens(input: string): string[] {
  const normalized = foldSpecialCharacters(
    input.normalize('NFD').replace(DIACRITICS, '').toLowerCase(),
  );
  return normalized.match(TOKEN_PATTERN) ?? [];
}

/**
 * Levenshtein distance capped at `max`. Returns `max + 1` as soon as the
 * distance provably exceeds the cap, which keeps fuzzy matching cheap.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0] as number;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] as number;
}

/** Counts non-overlapping occurrences of `needle` inside `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

