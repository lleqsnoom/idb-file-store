import { describe, expect, it } from 'vitest';
import type { FileRecord } from '../src/index.js';
import { ValidationError, planIndex } from '../src/index.js';
import { makeBlob, openDb } from './setup.js';

const DAY = 24 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2024, 0, 1);

/** Every seeded file, in the order `sort: { by: 'name' }` produces. */
const NAMES_BY_ASCENDING_NAME = [
  'beach-morning.png',
  'beach-sunset.jpg',
  'holiday.mp4',
  'invoice.pdf',
  'notes.md',
];

/** The two seeded images, in the order `sort: { by: 'name' }` produces. */
const IMAGES_BY_NAME = ['beach-morning.png', 'beach-sunset.jpg'];

/** Seeds a small, predictable library used by most query tests. */
async function seed() {
  const db = await openDb();
  const files: Array<[string, Blob, Parameters<typeof db.add>[1]]> = [
    ['beach-sunset.jpg', makeBlob(1000, 'image/jpeg'), {
      tags: ['trip', 'sunset'],
      folder: '/photos/2024',
      createdAt: EPOCH,
      favorite: true,
      notes: 'golden hour',
    }],
    ['beach-morning.png', makeBlob(2000, 'image/png'), {
      tags: ['trip'],
      folder: '/photos/2024',
      createdAt: EPOCH + DAY,
    }],
    ['holiday.mp4', makeBlob(3000, 'video/mp4'), {
      tags: ['trip', 'video'],
      folder: '/videos',
      createdAt: EPOCH + 2 * DAY,
    }],
    ['notes.md', new Blob(['packing list for the beach trip'], { type: 'text/markdown' }), {
      folder: '/notes',
      createdAt: EPOCH + 3 * DAY,
    }],
    ['invoice.pdf', makeBlob(4000, 'application/pdf'), {
      folder: '/documents',
      createdAt: EPOCH + 4 * DAY,
      metadata: { vendor: 'Acme', total: 120 },
    }],
  ];

  const records: FileRecord[] = [];
  for (const [name, blob, options] of files) {
    records.push(await db.add(blob, { name, ...options }));
  }
  return { db, records };
}

describe('where filters', () => {
  it('filters by kind, mime and extension', async () => {
    const { db } = await seed();

    expect(
      (await db.all({ where: { kind: 'image' }, sort: { by: 'name' } })).map((r) => r.name),
    ).toEqual(IMAGES_BY_NAME);
    expect((await db.all({ where: { kind: ['image', 'video'] } })).length).toBe(3);
    expect((await db.all({ where: { mime: 'application/pdf' } })).length).toBe(1);
    expect((await db.all({ where: { extension: 'png' } })).length).toBe(1);
    expect((await db.all({ where: { mime: { startsWith: 'image/' } } })).length).toBe(2);
    db.close();
  });

  it('filters by size ranges', async () => {
    const { db } = await seed();

    expect((await db.all({ where: { size: { gte: 2000 } } })).length).toBe(3);
    expect((await db.all({ where: { size: { gt: 1000, lt: 4000 } } })).length).toBe(2);
    expect((await db.all({ where: { size: { between: [1000, 2000] } } })).length).toBe(2);
    expect((await db.all({ where: { size: { ne: 1000 } } })).length).toBe(4);
    db.close();
  });

  it('filters by creation date using Date objects and ranges', async () => {
    const { db } = await seed();

    expect((await db.all({ where: { createdAt: new Date(EPOCH) } })).length).toBe(1);
    expect(
      (await db.all({ where: { createdAt: { gte: new Date(EPOCH + DAY) } } })).length,
    ).toBe(4);
    expect(
      (await db.all({ where: { createdAt: { between: [EPOCH, EPOCH + DAY] } } })).length,
    ).toBe(2);
    db.close();
  });

  it('filters by name, tags and folder', async () => {
    const { db } = await seed();

    expect((await db.all({ where: { name: { startsWith: 'beach' } } })).length).toBe(2);
    expect((await db.all({ where: { name: { contains: 'SUNSET' } } })).length).toBe(1);
    expect((await db.all({ where: { name: 'notes.md' } })).length).toBe(1);
    expect((await db.all({ where: { name: { regex: /\.(jpg|png)$/ } } })).length).toBe(2);

    expect((await db.all({ where: { tags: ['trip'] } })).length).toBe(3);
    expect((await db.all({ where: { tags: { any: ['sunset', 'video'] } } })).length).toBe(2);
    expect((await db.all({ where: { tags: { none: ['trip'] } } })).length).toBe(2);

    expect((await db.all({ where: { folder: '/photos/2024' } })).length).toBe(2);
    expect((await db.all({ where: { folder: { startsWith: '/photos' } } })).length).toBe(2);
    db.close();
  });

  it('reuses a caller-supplied global regex without skipping records', async () => {
    const { db } = await seed();

    // A `/g` pattern keeps `lastIndex` between calls, so a naive implementation
    // matches every other record once the same object is reused.
    const pattern = /beach/g;
    const first = await db.all({ where: { name: { regex: pattern } }, sort: { by: 'name' } });
    const second = await db.all({ where: { name: { regex: pattern } }, sort: { by: 'name' } });

    expect(first.map((r) => r.name)).toEqual(IMAGES_BY_NAME);
    expect(second.map((r) => r.name)).toEqual(IMAGES_BY_NAME);
    db.close();
  });

  it('plans an indexed subtree scan for folders and still drops siblings', async () => {
    const db = await openDb();
    await db.add('a', { name: 'a.txt', folder: '/photos' });
    await db.add('b', { name: 'b.txt', folder: '/photos/2024' });
    await db.add('c', { name: 'c.txt', folder: '/photos-old' });

    expect(planIndex({ folder: { startsWith: '/photos' } }).index).toBe('by_folder');

    const page = await db.all({
      where: { folder: { startsWith: '/photos' } },
      sort: { by: 'name' },
    });
    expect(page.map((r) => r.name)).toEqual(['a.txt', 'b.txt']);
    db.close();
  });

  it('filters by favorite and metadata', async () => {
    const { db } = await seed();

    expect((await db.all({ where: { favorite: true } })).length).toBe(1);
    expect((await db.all({ where: { favorite: false } })).length).toBe(4);
    expect((await db.all({ where: { metadata: { vendor: 'Acme' } } })).length).toBe(1);
    expect((await db.all({ where: { metadataContains: { vendor: 'acm' } } })).length).toBe(1);
    expect((await db.all({ where: { metadata: { vendor: ['Acme', 'Globex'] } } })).length).toBe(1);
    db.close();
  });

  it('intersects range operators, letting the tighter bound win', async () => {
    const { db } = await seed();

    // 3000 is the tighter floor, so 2000 no longer matches.
    expect((await db.all({ where: { size: { gt: 1000, gte: 3000 } } })).length).toBe(2);
    expect((await db.all({ where: { size: { gte: 2000, gt: 2000 } } })).length).toBe(2);

    // An open bound beats an inclusive one at the same value, so the seeded
    // 1000-byte file drops out.
    expect((await db.all({ where: { size: { gte: 1000, gt: 1000 } } })).length).toBe(3);

    // between combines with the operators the same way.
    expect((await db.all({ where: { size: { between: [1000, 4000], lt: 3000 } } })).length).toBe(2);
    db.close();
  });

  it('never treats an array as equal to a plain object', async () => {
    const db = await openDb();
    await db.add('a', { name: 'a.txt', metadata: { list: ['x'], empty: [] } });
    await db.add('b', { name: 'b.txt', metadata: { vendor: 'Acme' } });

    // A list expectation means "one of these values", and a stored array is
    // itself one value, so matching it means nesting it.
    expect((await db.all({ where: { metadata: { list: ['x'] } } })).length).toBe(0);
    expect((await db.all({ where: { metadata: { list: [['x']] } } })).length).toBe(1);
    expect((await db.all({ where: { metadata: { list: [['x'], ['y']] } } })).length).toBe(1);
    expect((await db.all({ where: { metadata: { list: [['y']] } } })).length).toBe(0);

    // An empty array and an empty object both have zero keys, so a structural
    // comparison would accept this query against the stored `[]`.
    expect((await db.all({ where: { metadata: { empty: {} } } })).length).toBe(0);

    expect((await db.all({ where: { metadata: { vendor: 'Acme' } } })).length).toBe(1);
    expect((await db.all({ where: { metadata: { vendor: {} } } })).length).toBe(0);
    db.close();
  });

  it('combines clauses with AND semantics', async () => {
    const { db } = await seed();
    const page = await db.list({
      where: { kind: 'image', tags: ['trip'], size: { gte: 1500 }, folder: '/photos/2024' },
    });
    expect(page.items.map((r) => r.name)).toEqual(['beach-morning.png']);
    db.close();
  });

  it('supports a custom predicate', async () => {
    const { db } = await seed();
    const page = await db.list({
      where: { custom: (record) => record.name.includes('invoice') || record.size === 1000 },
    });
    expect(page.total).toBe(2);
    db.close();
  });

  it('hides trashed records unless asked', async () => {
    const { db, records } = await seed();
    await db.trash([(records[0] as FileRecord).id]);

    expect(await db.count()).toBe(4);
    expect((await db.all({ where: { deleted: true } })).length).toBe(1);
    db.close();
  });
});

describe('sorting', () => {
  it('sorts by name, size and dates in both directions', async () => {
    const { db } = await seed();

    const ascending = await db.all({ sort: { by: 'name', order: 'asc' }, limit: Infinity });
    expect(ascending.map((r) => r.name)).toEqual(NAMES_BY_ASCENDING_NAME);

    const descending = await db.all({ sort: { by: 'size', order: 'desc' } });
    expect(descending[0]?.size).toBe(4000);

    const oldest = await db.first({ sort: { by: 'createdAt', order: 'asc' } });
    expect(oldest?.name).toBe('beach-sunset.jpg');
    db.close();
  });

  it('applies tie-breakers in order', async () => {
    const { db } = await seed();
    const page = await db.all({
      sort: [
        { by: 'kind', order: 'asc' },
        { by: 'size', order: 'desc' },
      ],
    });
    const images = page.filter((r) => r.kind === 'image');
    expect(images.map((r) => r.name)).toEqual(IMAGES_BY_NAME);
    db.close();
  });

  it('sorts favourites first', async () => {
    const { db } = await seed();
    const page = await db.all({ sort: [{ by: 'favorite', order: 'desc' }, { by: 'name' }] });
    expect(page[0]?.name).toBe('beach-sunset.jpg');
    expect(page[0]?.favorite).toBe(true);
    db.close();
  });

  it('orders naturally, so file10 comes after file2', async () => {
    const db = await openDb();
    for (const name of ['file10.txt', 'file2.txt', 'file1.txt']) {
      await db.add(name, { name });
    }
    const page = await db.all({ sort: { by: 'name' } });
    expect(page.map((r) => r.name)).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
    db.close();
  });
});

describe('pagination', () => {
  it('walks pages with limit and offset', async () => {
    const { db } = await seed();
    const first = await db.list({ sort: { by: 'name' }, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);

    const second = await db.list({ sort: { by: 'name' }, limit: 2, offset: 2 });
    expect(second.items).toHaveLength(2);
    expect(second.items[0]?.name).toBe('holiday.mp4');

    const third = await db.list({ sort: { by: 'name' }, limit: 2, offset: 4 });
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    db.close();
  });

  it('walks pages with a cursor, visiting every record once', async () => {
    const { db } = await seed();
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page = await db.list({ sort: { by: 'name' }, limit: 2, cursor });
      seen.push(...page.items.map((r) => r.name));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(NAMES_BY_ASCENDING_NAME);
    expect(new Set(seen).size).toBe(5);
    db.close();
  });

  it('rejects malformed cursors', async () => {
    const { db } = await seed();
    await expect(db.list({ cursor: 'not-a-cursor!!' })).rejects.toBeInstanceOf(ValidationError);
    db.close();
  });

  it('rejects negative limits and offsets', async () => {
    const { db } = await seed();
    await expect(db.list({ limit: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(db.list({ offset: -1 })).rejects.toBeInstanceOf(ValidationError);
    db.close();
  });

  it('returns an empty page past the end', async () => {
    const { db } = await seed();
    const page = await db.list({ limit: 3, offset: 50 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
    db.close();
  });
});

describe('search', () => {
  it('matches names and ranks them by score', async () => {
    const { db } = await seed();
    const page = await db.list({ search: 'beach', sort: { by: 'name' } });

    expect(page.total).toBe(3);
    expect(page.items[0]?.score).toBeGreaterThan(0);
    expect(page.items.every((r) => typeof r.score === 'number')).toBe(true);
  });

  it('matches extracted text', async () => {
    const { db } = await seed();
    const page = await db.list({ search: 'packing' });
    expect(page.items.map((r) => r.name)).toEqual(['notes.md']);
    db.close();
  });

  it('matches tags, folders, notes and metadata', async () => {
    const { db } = await seed();

    expect((await db.list({ search: 'sunset' })).total).toBe(1);
    expect((await db.list({ search: 'documents' })).total).toBe(1);
    expect((await db.list({ search: 'golden' })).total).toBe(1);
    expect((await db.list({ search: 'acme' })).total).toBe(1);
    db.close();
  });

  it('requires every token in "all" mode and one in "any" mode', async () => {
    const { db } = await seed();

    expect((await db.list({ search: 'beach morning' })).total).toBe(1);
    expect((await db.list({ search: 'beach morning' })).items[0]?.name).toBe('beach-morning.png');
    expect((await db.list({ search: 'nonexistent beach' })).total).toBe(0);
    expect(
      (await db.list({ search: { text: 'nonexistent beach', mode: 'any' } })).total,
    ).toBe(3);
    db.close();
  });

  it('restricts matching to selected fields', async () => {
    const { db } = await seed();

    expect((await db.list({ search: { text: 'sunset', fields: ['name'] } })).total).toBe(1);
    expect((await db.list({ search: { text: 'trip', fields: ['name'] } })).total).toBe(0);
    expect((await db.list({ search: { text: 'trip', fields: ['tags'] } })).total).toBe(3);
    db.close();
  });

  it('tolerates one-character typos in fuzzy mode', async () => {
    const { db } = await seed();

    expect((await db.list({ search: 'bech' })).total).toBe(0);
    // Every record whose text contains "beach" is within one edit of "bech".
    expect((await db.list({ search: { text: 'bech', fuzzy: true } })).total).toBe(3);
    db.close();
  });

  it('scores exact name matches above text matches', async () => {
    const db = await openDb();
    await db.add('beach', { name: 'beach.txt' });
    await db.add('a long document that mentions the beach once', { name: 'other.txt' });

    const page = await db.list({ search: 'beach' });
    expect(page.items[0]?.name).toBe('beach.txt');
    db.close();
  });

  it('accepts a boost multiplier', async () => {
    const { db } = await seed();
    const plain = await db.list({ search: 'beach' });
    const boosted = await db.list({ search: { text: 'beach', boost: 3 } });

    expect(boosted.items[0]?.score).toBeCloseTo((plain.items[0]?.score ?? 0) * 3, 5);
    db.close();
  });

  it('exposes a search() shortcut', async () => {
    const { db } = await seed();
    const page = await db.search('invoice', { limit: 5 });
    expect(page.items.map((r) => r.name)).toEqual(['invoice.pdf']);
    db.close();
  });

  it('combines search with filters', async () => {
    const { db } = await seed();
    const page = await db.list({ where: { folder: '/photos/2024' }, search: 'beach' });
    expect(page.total).toBe(2);
    db.close();
  });
});

describe('counting and streaming', () => {
  it('counts matches without materialising them', async () => {
    const { db } = await seed();
    expect(await db.count()).toBe(5);
    expect(await db.count({ where: { kind: 'image' } })).toBe(2);
    expect(await db.count({ search: 'beach' })).toBe(3);
    db.close();
  });

  it('returns the first match', async () => {
    const { db } = await seed();
    expect((await db.first({ sort: { by: 'name' } }))?.name).toBe('beach-morning.png');
    expect(await db.first({ where: { kind: 'archive' } })).toBeNull();
    db.close();
  });

  it('streams every record with iterate()', async () => {
    const { db } = await seed();
    const names: string[] = [];
    for await (const record of db.iterate()) names.push(record.name);
    expect(names).toHaveLength(5);
    db.close();
  });

  it('streams with filters and search applied', async () => {
    const { db } = await seed();
    const names: string[] = [];
    for await (const record of db.iterate({ search: 'beach' })) names.push(record.name);
    expect(names).toHaveLength(3);
    db.close();
  });

  it('sorts when iterate() is given a sort', async () => {
    const { db } = await seed();
    const names: string[] = [];
    for await (const record of db.iterate({ sort: { by: 'name', order: 'desc' } })) {
      names.push(record.name);
    }
    expect(names[0]).toBe('notes.md');
    db.close();
  });

  it('stops streaming when the signal is aborted', async () => {
    const { db } = await seed();
    const controller = new AbortController();
    const names: string[] = [];
    for await (const record of db.iterate({ signal: controller.signal })) {
      names.push(record.name);
    }
    expect(names).toHaveLength(5);

    controller.abort();
    const after: string[] = [];
    for await (const record of db.iterate({ signal: controller.signal })) after.push(record.name);
    expect(after).toEqual([]);
    db.close();
  });
});

describe('materialising extras', () => {
  it('attaches blobs, text and thumbnails when requested', async () => {
    const db = await openDb();
    const record = await db.add(new Blob(['body'], { type: 'text/plain' }), { name: 'a.txt' });

    const page = await db.list({ includeBlob: true, includeText: true, includeThumbnail: true });
    const item = page.items[0] as FileRecord;
    expect(item.id).toBe(record.id);
    expect(item.blob).toBeInstanceOf(Blob);
    expect(item.text).toBe('body');
    expect(item.thumbnail).toBeUndefined();
    db.close();
  });

  it('does not attach extras by default', async () => {
    const db = await openDb();
    await db.add('body', { name: 'a.txt' });
    const item = (await db.list()).items[0] as FileRecord;
    expect(item.blob).toBeUndefined();
    expect(item.text).toBeUndefined();
    db.close();
  });

  it('carries the relevance score through the page', async () => {
    const { db } = await seed();
    const page = await db.list({ search: 'invoice' });
    expect(page.items[0]?.score).toBeGreaterThan(0);
    db.close();
  });
});
