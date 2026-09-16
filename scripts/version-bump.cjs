"use strict";

/**
 * Determine the semver bump type from a set of conventional commits.
 *
 * Conventional Commits -> SemVer:
 *   feat:     -> minor
 *   fix:      -> patch
 *   perf:     -> patch (performance improvement treated as patch)
 *   BREAKING CHANGE / ! -> major
 *   docs, chore, refactor, style, test, ci -> no release
 *
 * The highest applicable bump wins. Returns "none" when there are no releasable
 * commits.
 *
 * CLI: reads newline-separated commit subjects on stdin and prints the bump type,
 * so the release workflow does not have to inline this logic in shell.
 *   git log --pretty=format:"%s" v1.0.0..HEAD | node scripts/version-bump.cjs
 */

/** Ordering of the bump types, so the highest one can be kept without branching. */
const RELEASE_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

const CONVENTIONAL_TYPES = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
};

const COMMIT_RE = /^(feat|fix|perf)(\(.+\))?(!)?[:.]\s+.+/;
const BREAKING_CHANGE_FOOTER_RE = /^BREAKING[ -]CHANGE:[\s\S]/im;

function getBumpType(commitMessage) {
  if (!commitMessage || typeof commitMessage !== "string") return null;

  const hasBreakingFooter = BREAKING_CHANGE_FOOTER_RE.test(commitMessage);
  const subjectMatch = COMMIT_RE.exec(commitMessage.split("\n")[0]);

  // A breaking change in the footer always wins.
  if (hasBreakingFooter) return "major";

  if (!subjectMatch) return null;

  const type = subjectMatch[1];
  const bang = subjectMatch[3];

  // Explicit breaking indicator: feat!: or fix!: etc.
  if (bang === "!") return "major";

  return CONVENTIONAL_TYPES[type] || null;
}

function getReleaseType(commits) {
  let highest = "none";

  for (const message of commits) {
    const bump = getBumpType(message);
    if (!bump) continue;
    if (RELEASE_RANK[bump] > RELEASE_RANK[highest]) highest = bump;
  }

  return highest;
}

function subjectsFrom(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function readStdin() {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (require.main === module) {
  process.stdout.write(`${getReleaseType(subjectsFrom(readStdin()))}\n`);
}

module.exports = { getBumpType, getReleaseType, subjectsFrom };