"use strict";

/**
 * Promote the Keep a Changelog "## [Unreleased]" section into a dated release
 * section and move the compare links forward. The release workflow commits the
 * result, so the released notes live in git rather than being generated from
 * commit subjects.
 *
 * When the Unreleased section is empty, the given commit subjects are used as
 * the entry instead, so a release never ships an empty section.
 *
 * CLI: node scripts/changelog.cjs <version> <YYYY-MM-DD> [file] < commits.txt
 */

const fs = require("node:fs");
const { subjectsFrom } = require("./version-bump.cjs");

const UNRELEASED_HEADING = "## [Unreleased]";
const SECTION_RE = /^## \[/m;
const UNRELEASED_LINK_RE = /^\[Unreleased\]:[ \t]*(\S+)[ \t]*$/m;
const COMPARE_MARKER = "/compare/";

function bulletsFor(commits) {
  const subjects = commits && commits.length ? commits : ["No user-visible changes."];
  return subjects.map((subject) => `- ${subject}`).join("\n");
}

/** The new Unreleased heading, the dated release heading and its body. */
function releaseSection(version, date, body) {
  return `${UNRELEASED_HEADING}\n\n## [${version}] - ${date}\n\n${body}\n\n`;
}

function promoteUnreleased(markdown, { version, date, commits = [] }) {
  // The first release can be calculated for a version whose notes are already
  // written out. Promoting again would duplicate the section, so leave the file
  // alone and keep the pending notes under Unreleased.
  if (hasSection(markdown, version)) return markdown;

  const start = markdown.indexOf(UNRELEASED_HEADING);

  let updated;
  if (start === -1) {
    // No Unreleased section to promote: open one above the first dated section.
    const firstSection = markdown.search(SECTION_RE);
    const insertAt = firstSection === -1 ? markdown.length : firstSection;
    updated =
      markdown.slice(0, insertAt) +
      releaseSection(version, date, bulletsFor(commits)) +
      markdown.slice(insertAt);
  } else {
    const bodyStart = start + UNRELEASED_HEADING.length;
    const next = markdown.slice(bodyStart).search(SECTION_RE);
    const bodyEnd = next === -1 ? markdown.length : bodyStart + next;
    const body = markdown.slice(bodyStart, bodyEnd).trim();
    updated =
      markdown.slice(0, start) +
      releaseSection(version, date, body || bulletsFor(commits)) +
      markdown.slice(bodyEnd);
  }

  return moveCompareLinks(updated, version);
}

/** True when the file already documents that version. */
function hasSection(markdown, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${escaped}\\]`, "m").test(markdown);
}

/**
 * `[Unreleased]: <url>/compare/v1.0.0...HEAD` becomes a comparison from the tag
 * just released, with the new tag's own reference line above the older ones.
 */
function moveCompareLinks(markdown, version) {
  const match = UNRELEASED_LINK_RE.exec(markdown);
  if (!match) return markdown;

  const url = match[1];
  const base = url.includes(COMPARE_MARKER)
    ? url.slice(0, url.indexOf(COMPARE_MARKER))
    : url;

  const replacement =
    `[Unreleased]: ${base}${COMPARE_MARKER}v${version}...HEAD\n` +
    `[${version}]: ${base}/releases/tag/v${version}`;

  return markdown.replace(UNRELEASED_LINK_RE, replacement);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (require.main === module) {
  const [version, date, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version || !date) {
    process.stderr.write("usage: changelog.cjs <version> <YYYY-MM-DD> [file]\n");
    process.exit(1);
  }

  const before = fs.readFileSync(file, "utf8");
  const commits = subjectsFrom(readStdin());

  if (hasSection(before, version)) {
    process.stdout.write(`${file} already documents ${version}; leaving it unchanged.\n`);
  } else {
    fs.writeFileSync(file, promoteUnreleased(before, { version, date, commits }));
    process.stdout.write(`Promoted the unreleased section to ${version}.\n`);
  }
}

module.exports = { promoteUnreleased, moveCompareLinks, hasSection };