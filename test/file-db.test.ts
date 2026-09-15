import { describe, expect, it } from 'vitest';
import {
  ClosedError,
  FileDB,
  NotFoundError,
  ValidationError,
  type FileRecord,
} from '../src/index.js';
import { bytesOf, makeBlob, openDb, textOf } from './setup.js';

describe('FileDB lifecycle', () => {
  it('opens lazily and reports its state', async () => {
    const db = new FileDB({ name: 'lifecycle', syncTabs: false });
    expect(db.isOpen).toBe(false);
    await db.open();
    expect(db.isOpen).toBe(true);
    db.close();
    expect(db.isOpen).toBe(false);
  });

  it('throws a helpful error when used before opening', async () => {
    const db = new FileDB({ name: 'not-open', syncTabs: false });
    await expect(db.list()).rejects.toBeInstanceOf(ClosedError);
  });

  it('opens through the static helper', async () => {
    const db = await FileDB.open({ name: 'static-open', syncTabs: false });
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it('is idempotent when opened twice concurrently', async () => {
    const db = new FileDB({ name: 'concurrent', syncTabs: false });
    await Promise.all([db.open(), db.open(), db.open()]);
    expect(db.isOpen).toBe(true);
    db.close();
  });
});

describe('add', () => {
  it('stores a text payload and derives name, mime and kind', async () => {
    const db = await openDb();
    const record = await db.add('hello world', { name: 'notes.md' });

    expect(record.name).toBe('notes.md');
    expect(record.mime).toBe('text/markdown');
    expect(record.kind).toBe('text');
    expect(record.extension).toBe('md');
    expect(record.size).toBe(11);
    expect(record.folder).toBe('/');
    expect(record.deleted).toBe(false);
    expect(record.revision).toBe(1);
    expect(record.hash).toMatch(/^sha256:/);
    db.close();
  });

  it('round-trips the bytes unchanged', async () => {
    const db = await openDb();
    const source = makeBlob(4096, 'video/mp4');
    const record = await db.add(source, { name: 'clip.mp4' });

    expect(record.chunkCount).toBe(1);
    const blob = await db.getBlob(record.id);
    expect(blob.size).toBe(4096);
    expect(blob.type).toBe('video/mp4');
    expect(await bytesOf(blob)).toEqual(await bytesOf(source));
    db.close();
  });

  it('splits large payloads into chunks and reassembles them', async () => {
    const db = await openDb({ chunkSize: 16 });
    const source = makeBlob(70, 'application/octet-stream');
    const record = await db.add(source, { name: 'big.bin' });

    expect(record.chunkSize).toBe(16);
    expect(record.chunkCount).toBe(5);
    expect(await bytesOf(await db.getBlob(record.id))).toEqual(await bytesOf(source));
    db.close();
  });

  it('reads a byte range without touching the whole file', async () => {
    const db = await openDb({ chunkSize: 8 });
    const source = makeBlob(40, 'application/octet-stream');
    const record = await db.add(source, { name: 'ranges.bin' });

    const slice = await db.readRange(record.id, 10, 20);
    const expected = (await bytesOf(source)).slice(10, 20);
    expect(await bytesOf(slice)).toEqual(expected);
    db.close();
  });

  it('extracts text from text-like payloads for search', async () => {
    const db = await openDb();
    const record = await db.add('the quick brown fox', { name: 'fox.txt' });
    expect(await db.getText(record.id)).toBe('the quick brown fox');
    db.close();
  });

  it('does not extract text from binary payloads', async () => {
    const db = await openDb();
    const record = await db.add(makeBlob(64, 'image/png'), { name: 'pixel.png' });
    expect(await db.getText(record.id)).toBe('');
    db.close();
  });

  it('normalises tags, folders and metadata', async () => {
    const db = await openDb();
    const record = await db.add('x', {
      name: 'a.txt',
      tags: ['  Trip ', 'trip', 'Sunset'],
      folder: 'photos//2024/',
      metadata: { camera: { make: 'Nikon', iso: 400 }, tags: ['a', 'b'] },
    });

    expect(record.tags).toEqual(['Trip', 'Sunset']);
    expect(record.folder).toBe('/photos/2024');
    expect(record.metadata).toEqual({ camera: { make: 'Nikon', iso: 400 }, tags: ['a', 'b'] });
    db.close();
  });

  it('rejects metadata that cannot survive a structured clone', async () => {
    const db = await openDb();
    await expect(
      db.add('x', { name: 'a.txt', metadata: { fn: (() => 1) as never } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      db.add('x', { name: 'a.txt', metadata: { blob: new Blob(['x']) as never } }),
    ).rejects.toBeInstanceOf(ValidationError);
    db.close();
  });

  it('rejects empty names and duplicate ids', async () => {
    const db = await openDb();
    await expect(db.add('x', { name: '   ' })).rejects.toBeInstanceOf(ValidationError);

    const first = await db.add('x', { name: 'a.txt', id: 'fixed' });
    expect(first.id).toBe('fixed');
    await expect(db.add('y', { name: 'b.txt', id: 'fixed' })).rejects.toBeInstanceOf(ValidationError);
    db.close();
  });

  it('accepts ArrayBuffer, typed arrays and Files', async () => {
    const db = await openDb();
    const fromBuffer = await db.add(new Uint8Array([1, 2, 3]).buffer, { name: 'a.bin' });
    const fromView = await db.add(new Uint8Array([4, 5, 6]), { name: 'b.bin' });
    const fromFile = await db.add(new File(['payload'], 'note.txt', { type: 'text/plain' }));

    expect(fromBuffer.size).toBe(3);
    expect(fromView.size).toBe(3);
    expect(fromFile.name).toBe('note.txt');
    expect(fromFile.mime).toBe('text/plain');
    db.close();
  });

  it('deduplicates identical payloads when asked', async () => {
    const db = await openDb({ dedupe: true });
    const first = await db.add('same bytes', { name: 'a.txt' });
    const second = await db.add('same bytes', { name: 'b.txt' });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('a.txt');
    expect(await db.count()).toBe(1);
    db.close();
  });

  it('adds many files and reports progress', async () => {
    const db = await openDb();
    const seen: number[] = [];
    const records = await db.addMany(['one', 'two', 'three'], {
      name: 'item.txt',
      onProgress: (done) => seen.push(done),
    });

    expect(records).toHaveLength(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(await db.count()).toBe(3);
    db.close();
  });

  it('skips hashing above the configured ceiling', async () => {
    const db = await openDb({ hashMaxBytes: 4 });
    const small = await db.add('abc', { name: 'small.txt' });
    const large = await db.add('abcdefgh', { name: 'large.txt' });

    expect(small.hash).toMatch(/^sha256:/);
    expect(large.hash).toBeNull();
    db.close();
  });
});

describe('get', () => {
  it('throws NotFoundError for an unknown id', async () => {
    const db = await openDb();
    await expect(db.get('missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.find('missing')).toBeNull();
    db.close();
  });

  it('attaches the blob, text and score only when asked', async () => {
    const db = await openDb();
    const record = await db.add('searchable text', { name: 'doc.txt' });

    const plain = await db.get(record.id);
    expect(plain.blob).toBeUndefined();
    expect(plain.text).toBeUndefined();

    const rich = await db.get(record.id, { includeBlob: true, includeText: true });
    expect(rich.blob).toBeInstanceOf(Blob);
    expect(rich.text).toBe('searchable text');
    db.close();
  });

  it('bumps accessedAt only when touching is requested', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt', createdAt: 1_000 });
    expect(record.accessedAt).toBe(1_000);

    await db.get(record.id);
    expect((await db.get(record.id)).accessedAt).toBe(1_000);

    await db.get(record.id, { touch: true });
    expect((await db.get(record.id)).accessedAt).toBeGreaterThan(1_000);
    db.close();
  });

  it('reports existence and survives trashing', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt' });

    expect(await db.has(record.id)).toBe(true);
    await db.trash([record.id]);
    expect(await db.has(record.id)).toBe(false);
    db.close();
  });
});

describe('update', () => {
  it('patches metadata fields and bumps the revision', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt', tags: ['one'] });
    const updated = await db.update(record.id, {
      name: 'renamed.md',
      tags: ['two'],
      folder: '/notes',
      favorite: true,
      notes: 'remember this',
    });

    expect(updated.name).toBe('renamed.md');
    expect(updated.extension).toBe('md');
    expect(updated.tags).toEqual(['two']);
    expect(updated.folder).toBe('/notes');
    expect(updated.favorite).toBe(true);
    expect(updated.notes).toBe('remember this');
    expect(updated.revision).toBe(2);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
    db.close();
  });

  it('replaces bytes and refreshes size, hash and search text', async () => {
    const db = await openDb();
    const record = await db.add('old content', { name: 'a.txt' });
    const updated = await db.update(record.id, { data: 'brand new content' });

    expect(updated.size).toBe(17);
    expect(updated.hash).not.toBe(record.hash);
    expect(await db.getText(record.id)).toBe('brand new content');
    expect(await textOf(await db.getBlob(record.id))).toBe('brand new content');
    db.close();
  });

  it('reports missing records and skips them in bulk updates', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt' });

    await expect(db.update('missing', { favorite: true })).rejects.toBeInstanceOf(NotFoundError);
    const updated = await db.updateMany(['missing', record.id], { favorite: true });
    expect(updated).toHaveLength(1);
    db.close();
  });

  it('adds and removes tags without replacing the list', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt', tags: ['one', 'two'] });

    const added = await db.setTags(record.id, { add: ['three'], remove: ['ONE'] });
    expect(added.tags).toEqual(['two', 'three']);
    db.close();
  });

  it('moves and stars many records at once', async () => {
    const db = await openDb();
    const a = await db.add('a', { name: 'a.txt' });
    const b = await db.add('b', { name: 'b.txt' });

    await db.move([a.id, b.id], 'archive/2024');
    await db.setFavorite([a.id], true);

    expect((await db.get(a.id)).folder).toBe('/archive/2024');
    expect((await db.get(b.id)).folder).toBe('/archive/2024');
    expect((await db.get(a.id)).favorite).toBe(true);
    db.close();
  });

  it('supports a custom transaction body', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt' });

    const name = await db.transaction('files', 'readonly', async (tx, wait) => {
      const row = await wait(tx.objectStore('files').get(record.id) as IDBRequest<FileRecord>);
      return row.name;
    });
    expect(name).toBe('a.txt');
    db.close();
  });
});

describe('delete, trash and restore', () => {
  it('trashes, restores and purges a record', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt' });

    const [trashed] = await db.trash([record.id]);
    expect(trashed.deleted).toBe(true);
    expect(trashed.deletedAt).toBeTypeOf('number');
    expect(await db.count({ where: { deleted: true } })).toBe(1);
    expect(await db.count()).toBe(0);

    const [restored] = await db.restore([record.id]);
    expect(restored.deleted).toBe(false);
    expect(await db.count()).toBe(1);

    expect(await db.purge([record.id])).toBe(1);
    expect(await db.find(record.id)).toBeNull();
    db.close();
  });

  it('purges a record only once even when called repeatedly', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt' });

    expect(await db.purge([record.id])).toBe(1);
    expect(await db.purge([record.id])).toBe(0);
    db.close();
  });

  it('empties the trash', async () => {
    const db = await openDb();
    const a = await db.add('a', { name: 'a.txt' });
    const b = await db.add('b', { name: 'b.txt' });
    await db.trash([a.id, b.id]);

    expect(await db.emptyTrash()).toBe(2);
    expect(await db.count({ where: { deleted: true } })).toBe(0);
    db.close();
  });

  it('removes the bytes when a record is purged', async () => {
    const db = await openDb();
    const record = await db.add(makeBlob(100), { name: 'a.bin' });
    await db.purge([record.id]);

    expect(await db.pruneOrphans()).toBe(0);
    db.close();
  });

  it('clears everything but keeps the database usable', async () => {
    const db = await openDb();
    await db.add('a', { name: 'a.txt' });
    await db.clear();

    expect(await db.count()).toBe(0);
    await db.add('b', { name: 'b.txt' });
    expect(await db.count()).toBe(1);
    db.close();
  });

  it('drops orphaned chunks with pruneOrphans', async () => {
    const db = await openDb({ chunkSize: 4 });
    const record = await db.add(makeBlob(16), { name: 'a.bin' });

    // Simulate a crash between writing chunks and writing the record.
    await db.transaction('files', 'readwrite', async (tx, wait) => {
      await wait(tx.objectStore('files').delete(record.id));
    });

    expect(await db.pruneOrphans()).toBe(4);
    expect(await db.pruneOrphans()).toBe(0);
    db.close();
  });

  it('destroys the whole database', async () => {
    const db = await openDb();
    await db.add('a', { name: 'a.txt' });
    await db.destroy();
    expect(db.isOpen).toBe(false);
  });
});

describe('stats and facets', () => {
  it('aggregates totals by kind and mime', async () => {
    const db = await openDb();
    await db.add(makeBlob(10, 'image/png'), { name: 'a.png' });
    await db.add(makeBlob(20, 'image/jpeg'), { name: 'b.jpg' });
    await db.add(makeBlob(30, 'video/mp4'), { name: 'c.mp4' });
    const trashed = await db.add(makeBlob(5, 'text/plain'), { name: 'd.txt' });
    await db.trash([trashed.id]);

    const stats = await db.stats();
    expect(stats.count).toBe(3);
    expect(stats.size).toBe(60);
    expect(stats.trashedCount).toBe(1);
    expect(stats.trashedSize).toBe(5);
    expect(stats.byKind.image).toEqual({ count: 2, size: 30 });
    expect(stats.byKind.video).toEqual({ count: 1, size: 30 });
    expect(stats.byMime['image/png']).toEqual({ count: 1, size: 10 });
    expect(stats.range.oldest).toBeTypeOf('number');
    db.close();
  });

  it('counts facets for a filtered subset', async () => {
    const db = await openDb();
    await db.add(makeBlob(10, 'image/png'), { name: 'a.png', tags: ['trip'], folder: '/p' });
    await db.add(makeBlob(20, 'image/png'), { name: 'b.png', tags: ['trip', 'sun'], folder: '/p' });
    await db.add(makeBlob(30, 'video/mp4'), { name: 'c.mp4', folder: '/v' });

    const images = await db.facets({ where: { kind: 'image' } });
    expect(images.count).toBe(2);
    expect(images.size).toBe(30);
    expect(images.sizeRange).toEqual({ min: 10, max: 20 });
    expect(images.byKind).toEqual({ image: 2 });
    expect(images.byTag).toEqual({ trip: 2, sun: 1 });
    expect(images.byFolder).toEqual({ '/p': 2 });
    db.close();
  });
});

describe('backup and restore', () => {
  it('round-trips every record with its bytes', async () => {
    const db = await openDb({ chunkSize: 8 });
    const source = makeBlob(40);
    await db.add(source, { name: 'a.bin', tags: ['x'], folder: '/f' });
    await db.add('text content', { name: 'b.txt' });

    const backup = await db.backup();
    expect(backup.entries).toHaveLength(2);

    await db.clear();
    expect(await db.count()).toBe(0);

    const restored = await db.restoreBackup(backup);
    expect(restored).toBe(2);

    const page = await db.list({ sort: { by: 'name' } });
    const first = page.items.find((item) => item.name === 'a.bin') as FileRecord;
    expect(first.tags).toEqual(['x']);
    expect(first.folder).toBe('/f');
    expect(await bytesOf(await db.getBlob(first.id))).toEqual(await bytesOf(source));

    const second = page.items.find((item) => item.name === 'b.txt') as FileRecord;
    expect(await db.getText(second.id)).toBe('text content');
    db.close();
  });

  it('preserves trashed records', async () => {
    const db = await openDb();
    const record = await db.add('x', { name: 'a.txt' });
    await db.trash([record.id]);

    const backup = await db.backup();
    await db.clear();
    await db.restoreBackup(backup);

    expect(await db.count()).toBe(0);
    expect(await db.count({ where: { deleted: true } })).toBe(1);
    db.close();
  });

  it('rejects an unknown backup format', async () => {
    const db = await openDb();
    await expect(
      db.restoreBackup({ format: 2 as never, database: 'x', createdAt: 0, entries: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    db.close();
  });

  it('exports a record as a File', async () => {
    const db = await openDb();
    const record = await db.add('file body', { name: 'export.txt' });
    const file = await db.exportFile(record.id);

    expect(file.name).toBe('export.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('file body');
    db.close();
  });

  it('writes a snapshot without bytes', async () => {
    const db = await openDb();
    await db.add('a', { name: 'a.txt' });

    const snapshot = await db.snapshot();
    expect(snapshot.format).toBe(1);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]?.blob).toBeUndefined();
    expect(JSON.parse(JSON.stringify(snapshot)).records).toHaveLength(1);
    db.close();
  });
});

describe('events', () => {
  it('emits add, update and delete through the change channel', async () => {
    const db = await openDb();
    const types: string[] = [];
    db.on('change', (change) => types.push(change.type));
    db.on('add', () => types.push('add'));
    db.on('update', () => types.push('update'));
    db.on('delete', () => types.push('delete'));
    db.on('restore', () => types.push('restore'));
    db.on('purge', () => types.push('purge'));

    const record = await db.add('x', { name: 'a.txt' });
    await db.update(record.id, { favorite: true });
    await db.trash([record.id]);
    await db.restore([record.id]);
    await db.purge([record.id]);
    await db.clear();

    expect(types).toEqual([
      'add',
      'add',
      'update',
      'update',
      'delete',
      'delete',
      'restore',
      'restore',
      'purge',
      'purge',
      'clear',
    ]);
    db.close();
  });

  it('notifies duplicates when deduplication skips a write', async () => {
    const db = await openDb({ dedupe: true });
    await db.add('same', { name: 'a.txt' });

    let duplicates = 0;
    db.on('duplicate', () => (duplicates += 1));
    await db.add('same', { name: 'b.txt' });
    expect(duplicates).toBe(1);
    db.close();
  });

  it('unsubscribes listeners', async () => {
    const db = await openDb();
    let calls = 0;
    const off = db.on('add', () => (calls += 1));

    await db.add('a', { name: 'a.txt' });
    off();
    await db.add('b', { name: 'b.txt' });
    expect(calls).toBe(1);
    db.close();
  });

  it('isolates a throwing listener', async () => {
    const db = await openDb();
    db.on('add', () => {
      throw new Error('listener boom');
    });
    await expect(db.add('a', { name: 'a.txt' })).resolves.toBeDefined();
    db.close();
  });
});
