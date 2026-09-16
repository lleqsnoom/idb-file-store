# Contributing

Thanks for taking the time to improve `idb-file-store`.

## Getting set up

```bash
git clone https://github.com/lleqsnoom/idb-file-store.git
cd idb-file-store
npm install
npm run check
```

`npm run check` runs the type checker, the test suite and the build. If it passes
on a clean checkout, your environment is ready.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` with strict settings |
| `npm test` | Vitest against an in-memory IndexedDB |
| `npm run test:watch` | Same, in watch mode |
| `npm run coverage` | Coverage report for `src/` |
| `npm run build` | `tsup` -> ESM, CJS and `.d.ts` in `dist/` |
| `npm run example` | The playground app on http://localhost:5173 |
| `npm run check` | Typecheck, test, build |

## Ground rules

- **No runtime dependencies.** The library ships to browsers and must stay small
  and self-contained. If you need something, check whether twenty lines solve it.
- **Strict TypeScript.** `strict`, `verbatimModuleSyntax` and `noUnusedLocals` are
  on. Prefer `import type` for type-only imports.
- **ESM-style relative imports** with an explicit `.js` extension, as the rest of
  the source does.
- **No em dashes in source code.** Use commas, parentheses or semicolons.
- **Public API changes need docs.** Update `docs/api.md` and the README table when
  you add or rename anything users touch.
- **JSDoc on exports, but only when it earns its place.** State the behaviour the
  signature cannot: accepted inputs, thrown errors, units, defaults, or *why* a
  non-obvious choice was made. Do not restate the name: `/** Tests a string field
  against a string filter. */` above `matchesString` is noise, and the reader is
  better served by nothing. If the only honest sentence repeats the identifier,
  delete the comment.

## Tests

The suite runs on [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB),
so no browser is needed. Create a fresh factory per test so nothing leaks:

```ts
import { IDBFactory } from 'fake-indexeddb';
import { FileDB } from '../src/index.js';

const db = await FileDB.open({
  name: `test-${Math.random()}`,
  indexedDB: new IDBFactory(),
  syncTabs: false,
});
```

`test/setup.ts` already wraps this in `openDb()` and `createDb()` helpers.

What a change should come with:

- A test that fails before it and passes after it. Bug fixes included.
- A test for the error path, not just the happy path.
- A test for any boundary you had to reason about: an empty string, a zero-length
  file, an inclusive upper bound, a record that no longer exists.

There is no coverage threshold, but `npm run coverage` is a useful sanity check
that a new branch is actually exercised.

## Changing the schema

Schema changes are the highest-risk kind of change, because they run against data
people already have.

1. Bump `SCHEMA_VERSION` in `src/storage/schema.ts`.
2. Add an **additive** step to `upgradeSchema()` guarded by `oldVersion < N`.
3. Test both paths: a fresh database created at the new version, and a database
   created at the old version that is then reopened at the new one.
4. If the step changes the shape of a store, also test a database that already reports
   the version you are leaving, but without the shape: a version number can be raised
   before the step that gives it meaning exists, and a guard of `oldVersion < N` alone
   will skip those databases (see the version 3 repair for an example).

Never modify an existing step. A version 1 database must still migrate through the
exact code that created it.

## Changing the query engine

`src/query/` is pure logic over stored rows, with no IndexedDB calls outside
`plan.ts`. That makes it easy to test a predicate or a scoring rule directly.

Two invariants must hold:

1. **Index planning never changes results.** The planner is a heuristic for speed
   only, because `matchesRecord` always runs afterwards. A test that asserts a
   result must not depend on which index was chosen.
2. **Ordering is total.** `compareRecords` falls back to `id`, which is what makes
   cursor pagination stable. Do not remove that fallback.

When you add a filter, add the plan case too, and a test that the index it selects
cannot hide matching records. The multi-entry `by_tags` index is the cautionary
example: it is sound for `all` lists and unsound for `any` lists with several
alternatives.

## Documentation

| File | Update it when |
| --- | --- |
| `README.md` | The feature list, the API summary or the install instructions change |
| `docs/api.md` | Any public signature, option or type changes |
| `docs/querying.md` | Filtering, sorting, search scoring or pagination behaviour changes |
| `docs/recipes.md` | You find a pattern worth showing end to end |
| `docs/architecture.md` | The schema, the query pipeline or a design decision changes |
| `CHANGELOG.md` | Anything user-visible changes |

## Submitting a change

1. Branch from `main`.
2. Keep the diff focused. Unrelated cleanups in the same pull request make the
   review harder than it needs to be.
3. Run `npm run check`.
4. Write a commit subject that explains the outcome, not the mechanics:
   `fix: keep cursor pagination stable when sort keys tie` beats
   `fix: compareRecords fallback`.
5. Open a pull request describing what problem it solves and how you verified it.

If you are planning something large, open an issue first. It is much easier to
agree on an approach before the code exists.
