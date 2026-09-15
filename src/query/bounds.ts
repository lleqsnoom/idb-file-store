import type { NumberOperators } from '../types.js';

/**
 * Deriving the effective range from numeric operators.
 *
 * Both the predicate pass and the index planner need to know which bounds a
 * filter implies. Keeping the rule here means they cannot disagree: a value
 * accepted by a predicate is always a value the planned range can reach.
 *
 * The rule is: the tightest lower bound wins, the tightest upper bound wins, and
 * at the same value an open endpoint beats an inclusive one, because excluding a
 * value is stricter than including it.
 */

/** A range endpoint and whether it excludes the value it names. */
export interface Bound {
  value: number;
  open: boolean;
}

/** The highest lower bound the operators imply, or `null` for none. */
export function tighterLower(operators: NumberOperators): Bound | null {
  const candidates: Bound[] = [];
  if (operators.gt !== undefined) candidates.push({ value: operators.gt, open: true });
  if (operators.gte !== undefined) candidates.push({ value: operators.gte, open: false });
  if (operators.between) candidates.push({ value: operators.between[0], open: false });
  return pickBound(candidates, true);
}

/** The lowest upper bound the operators imply, or `null` for none. */
export function tighterUpper(operators: NumberOperators): Bound | null {
  const candidates: Bound[] = [];
  if (operators.lt !== undefined) candidates.push({ value: operators.lt, open: true });
  if (operators.lte !== undefined) candidates.push({ value: operators.lte, open: false });
  if (operators.between) candidates.push({ value: operators.between[1], open: false });
  return pickBound(candidates, false);
}

/**
 * `true` when the value satisfies the range.
 *
 * Testing only the two tightest bounds is enough: anything that clears the
 * tightest lower bound clears every looser one, because it is the largest.
 *
 * @param value - The number to test.
 * @param lower - Tightest lower bound, or `null` when the range has no floor.
 * @param upper - Tightest upper bound, or `null` when the range has no ceiling.
 */
export function satisfiesBounds(value: number, lower: Bound | null, upper: Bound | null): boolean {
  if (lower && (lower.open ? value <= lower.value : value < lower.value)) return false;
  if (upper && (upper.open ? value >= upper.value : value > upper.value)) return false;
  return true;
}

/**
 * Picks the most restrictive candidate.
 *
 * `preferHigher` is `true` for a lower bound, where the largest value is tightest,
 * and `false` for an upper bound.
 */
function pickBound(candidates: Bound[], preferHigher: boolean): Bound | null {
  let best: Bound | null = null;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.value === best.value) {
      if (candidate.open) best = candidate;
      continue;
    }
    const tighter = preferHigher ? candidate.value > best.value : candidate.value < best.value;
    if (tighter) best = candidate;
  }
  return best;
}
