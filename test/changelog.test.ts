import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { hasSection, moveCompareLinks, promoteUnreleased } = require(
  '../scripts/changelog.cjs',
) as {
  promoteUnreleased: (
    markdown: string,
    options: { version: string; date: string; commits?: string[] },
  ) => string;
  moveCompareLinks: (markdown: string, version: string) => string;
  hasSection: (markdown: string, version: string) => boolean;
};

const HEADER = '# Changelog\n\nAll notable changes are documented here.\n\n';

describe('promoteUnreleased', () => {
  it('dates the unreleased section and opens a fresh one above it', () => {
    const before =
      `${HEADER}## [Unreleased]\n\n### Added\n\n- Records share identical bytes.\n\n` +
      '## [0.1.0] - 2026-09-15\n\nFirst release.\n';

    const after = promoteUnreleased(before, { version: '0.2.0', date: '2026-09-16' });

    expect(after).toBe(
      `${HEADER}## [Unreleased]\n\n## [0.2.0] - 2026-09-16\n\n### Added\n\n` +
        '- Records share identical bytes.\n\n' +
        '## [0.1.0] - 2026-09-15\n\nFirst release.\n',
    );
  });

  it('keeps the released section intact and adds no duplicate content', () => {
    const before = `${HEADER}## [Unreleased]\n\n### Fixed\n\n- A bug.\n\n## [0.1.0] - 2026-09-15\n\nFirst release.\n`;

    const after = promoteUnreleased(before, { version: '0.1.1', date: '2026-09-16' });

    expect(after.match(/### Fixed/g)).toHaveLength(1);
    expect(after).toContain('## [0.1.1] - 2026-09-16\n\n### Fixed\n\n- A bug.');
  });

  it('falls back to the commit subjects when the unreleased section is empty', () => {
    const before = `${HEADER}## [Unreleased]\n\n## [0.1.0] - 2026-09-15\n\nFirst release.\n`;

    const after = promoteUnreleased(before, {
      version: '0.2.0',
      date: '2026-09-16',
      commits: ['feat: share identical bytes', 'fix: correct the browser floor'],
    });

    expect(after).toContain(
      '## [0.2.0] - 2026-09-16\n\n' +
        '- feat: share identical bytes\n- fix: correct the browser floor\n',
    );
  });

  it('says so when an empty section has no commits either', () => {
    const after = promoteUnreleased(`${HEADER}## [Unreleased]\n`, {
      version: '0.2.0',
      date: '2026-09-16',
    });

    expect(after).toContain('## [0.2.0] - 2026-09-16\n\n- No user-visible changes.');
  });

  it('opens a release section when there is no unreleased heading at all', () => {
    const before = `${HEADER}## [0.1.0] - 2026-09-15\n\nFirst release.\n`;

    const after = promoteUnreleased(before, {
      version: '0.2.0',
      date: '2026-09-16',
      commits: ['feat: store identical bytes once'],
    });

    expect(after).toBe(
      `${HEADER}## [Unreleased]\n\n## [0.2.0] - 2026-09-16\n\n` +
        '- feat: store identical bytes once\n\n' +
        '## [0.1.0] - 2026-09-15\n\nFirst release.\n',
    );
  });

  it('appends the section when the file has no dated sections', () => {
    const after = promoteUnreleased(`${HEADER}`, {
      version: '0.2.0',
      date: '2026-09-16',
      commits: ['feat: a first release'],
    });

    expect(after).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-09-16');
  });

  it('leaves the file alone when that version is already documented', () => {
    const before =
      `${HEADER}## [Unreleased]\n\n### Added\n\n- Pending work.\n\n` +
      '## [0.1.0] - 2026-09-15\n\nFirst release.\n';

    expect(promoteUnreleased(before, { version: '0.1.0', date: '2026-09-16' })).toBe(before);
    expect(hasSection(before, '0.1.0')).toBe(true);
  });
});

describe('moveCompareLinks', () => {
  it('points the unreleased comparison at the tag just released', () => {
    const before =
      '[Unreleased]: https://github.com/lleqsnoom/idb-file-store/compare/v0.1.0...HEAD\n' +
      '[0.1.0]: https://github.com/lleqsnoom/idb-file-store/releases/tag/v0.1.0\n';

    expect(moveCompareLinks(before, '0.2.0')).toBe(
      '[Unreleased]: https://github.com/lleqsnoom/idb-file-store/compare/v0.2.0...HEAD\n' +
        '[0.2.0]: https://github.com/lleqsnoom/idb-file-store/releases/tag/v0.2.0\n' +
        '[0.1.0]: https://github.com/lleqsnoom/idb-file-store/releases/tag/v0.1.0\n',
    );
  });

  it('leaves a file without link definitions alone', () => {
    expect(moveCompareLinks('# Changelog\n', '0.2.0')).toBe('# Changelog\n');
  });
});