import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { getBumpType, getReleaseType, subjectsFrom } = require('../scripts/version-bump.cjs') as {
  getBumpType: (commitMessage: string | null) => 'major' | 'minor' | 'patch' | null;
  getReleaseType: (commits: string[]) => 'major' | 'minor' | 'patch' | 'none';
  subjectsFrom: (text: string) => string[];
};

describe('getBumpType', () => {
  it('returns "major" for a BREAKING CHANGE footer', () => {
    expect(
      getBumpType('feat: add a new auth module\n\nBREAKING CHANGE: the old API is gone'),
    ).toBe('major');
  });

  it('returns "major" when the body, not just the footer, says BREAKING-CHANGE', () => {
    const message = `feat: restructure the on-disk layout

The directory structure changes.

BREAKING-CHANGE: chunks are now keyed by content id`;

    expect(getBumpType(message)).toBe('major');
  });

  it('returns "major" for an explicit breaking indicator', () => {
    expect(getBumpType('feat!: remove the deprecated config flag')).toBe('major');
    expect(getBumpType('fix!: change the default chunk size')).toBe('major');
  });

  it('returns "minor" for feat, with or without a scope', () => {
    expect(getBumpType('feat: add pruneOrphans')).toBe('minor');
    expect(getBumpType('feat(query): allow nested metadata filters')).toBe('minor');
  });

  it('returns "patch" for fix and perf', () => {
    expect(getBumpType('fix: correct badge URL formatting')).toBe('patch');
    expect(getBumpType('fix(install): handle a missing skills directory')).toBe('patch');
    expect(getBumpType('perf: optimize the install loop')).toBe('patch');
  });

  it('returns null for types that do not release', () => {
    expect(getBumpType('docs: rewrite the README')).toBeNull();
    expect(getBumpType('chore: bump version to 0.1.0')).toBeNull();
    expect(getBumpType('refactor: extract the range rule')).toBeNull();
    expect(getBumpType('test: cover empty batches')).toBeNull();
    expect(getBumpType('ci: cache npm for the playground build')).toBeNull();
  });

  it('returns null for merge commits, free text, empty strings and null', () => {
    expect(getBumpType('Merge pull request #2 from lleqsnoom/feat/x')).toBeNull();
    expect(getBumpType('just some random text')).toBeNull();
    expect(getBumpType('')).toBeNull();
    expect(getBumpType(null)).toBeNull();
  });
});

describe('getReleaseType', () => {
  it('returns "none" when nothing is releasable', () => {
    expect(getReleaseType([])).toBe('none');
    expect(
      getReleaseType(['chore: update deps', 'docs: fix a typo', 'refactor: tidy utils']),
    ).toBe('none');
  });

  it('returns the highest applicable bump', () => {
    expect(getReleaseType(['feat: add a thing', 'chore: update deps'])).toBe('minor');
    expect(
      getReleaseType(['fix: correct a bug', 'feat: add a thing', 'docs: update docs']),
    ).toBe('minor');
    expect(getReleaseType(['perf: speed up writes', 'chore: cleanup'])).toBe('patch');
    expect(
      getReleaseType(['fix: correct a bug', 'fix!: drop the old row shape']),
    ).toBe('major');
    expect(
      getReleaseType(['fix: correct a bug', 'feat: add a thing\n\nBREAKING CHANGE: gone']),
    ).toBe('major');
  });
});

describe('subjectsFrom', () => {
  it('splits, trims and drops blank lines', () => {
    expect(subjectsFrom('feat: a\n\n  fix: b  \n')).toEqual(['feat: a', 'fix: b']);
    expect(subjectsFrom('')).toEqual([]);
  });
});