# Recipes

Task-oriented examples. Each one is self-contained and uses only the public API.

- [Open a database once and share it](#open-a-database-once-and-share-it)
- [Drag-and-drop upload with de-duplication](#drag-and-drop-upload-with-de-duplication)
- [Image gallery with lazy thumbnails](#image-gallery-with-lazy-thumbnails)
- [Video playback and frame extraction](#video-playback-and-frame-extraction)
- [Folder tree from facets](#folder-tree-from-facets)
- [A trash view](#a-trash-view)
- [Storage meter](#storage-meter)
- [Backup and restore in the browser](#backup-and-restore-in-the-browser)
- [Ask the browser to keep your data](#ask-the-browser-to-keep-your-data)
- [Keep two tabs in sync](#keep-two-tabs-in-sync)
- [A paged list in React](#a-paged-list-in-react)
- [Upload a whole directory](#upload-a-whole-directory)
- [Test against an in-memory database](#test-against-an-in-memory-database)

---

## Open a database once and share it

Create the instance at module scope, open it lazily, and export it. Opening three
times from three components wastes connections and re-registers listeners.

```ts
// storage.ts
import { FileDB } from 'idb-file-store';

export const db = new FileDB({ name: 'my-vault' });
export const ready = db.open();
```

```ts
// anywhere else
import { db, ready } from './storage';

await ready;
const page = await db.list({ limit: 24 });
```

Call `db.close()` when the app unmounts (or on `beforeunload`) so a later schema
upgrade is not blocked by a stale connection.

---

## Drag-and-drop upload with de-duplication

`dedupe: true` returns an existing record when the bytes are already stored, so
re-uploading the same photo does not double your storage.

```ts
const db = new FileDB({ name: 'my-vault', dedupe: true });
await db.open();

dropZone.addEventListener('dragover', (event) => event.preventDefault());

dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files ?? []);

  const stored = await db.addMany(files, {
    folder: '/uploads',
    onProgress: (done, total) => {
      progressBar.style.width = `${(done / total) * 100}%`;
    },
  });

  // A record that already existed keeps its original id and name.
  console.log(`${stored.length} files handled`);
});
```

Give the same payload a different name and the library still returns the original
record, which is usually what you want: one copy of the bytes, one canonical
record.

---

## Image gallery with lazy thumbnails

Thumbnails are generated at write time for images (when the runtime supports
`createImageBitmap`). The grid fetches metadata first and previews only for the
tiles it renders.

```ts
const db = new FileDB({ name: 'my-vault' });
await db.open();

const grid = document.querySelector('#grid');

async function renderGallery() {
  const page = await db.list({
    where: { kind: 'image', deleted: false },
    sort: { by: 'createdAt', order: 'desc' },
    limit: 60,
  });

  grid.replaceChildren(...page.items.map(tile));
  status.textContent = `${page.total} images`;
}

function tile(record) {
  const figure = document.createElement('figure');
  const img = document.createElement('img');
  img.alt = record.name;
  img.loading = 'lazy';
  img.dataset.id = record.id;

  const caption = document.createElement('figcaption');
  caption.textContent = `${record.name} - ${formatBytes(record.size)}`;

  figure.append(img, caption);
  return figure;
}

// Fetch previews only as the browser actually needs them.
const observer = new IntersectionObserver(async (entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);

    const id = entry.target.dataset.id;
    const preview = (await db.getThumbnail(id)) ?? (await db.getBlob(id));
    const url = URL.createObjectURL(preview);
    entry.target.src = url;
    entry.target.dataset.url = url;
  }
});

grid.addEventListener('load', (event) => event.target.tagName === 'IMG'
  && observer.observe(event.target), true);
```

`formatBytes` is exported by the library, so your UI can spell sizes the same way
`stats()` does.

---

## Video playback and frame extraction

For playback, hand the browser a blob URL: it can then make range requests
against the blob without you writing any code.

```ts
const record = await db.first({ where: { kind: 'video' }, sort: { by: 'size', order: 'desc' } });

const url = await db.getObjectURL(record.id);
video.src = url;

// Release it when the player goes away.
video.addEventListener('emptied', () => db.revokeObjectURL(url), { once: true });
```

When you need specific bytes, `readRange()` reads only the chunks that overlap
the window. That is how you pull a poster frame out of a container header, or
feed a custom player that does its own fetching.

```ts
// Grab the first 64 KiB to parse a container header.
const header = await db.readRange(record.id, 0, 64 * 1024);
const headerBytes = new Uint8Array(await header.arrayBuffer());

// Grab a 1 MiB window 30 seconds in for a poster frame.
const frame = await db.readRange(record.id, 30_000 * 512, 30_000 * 512 + 1024 * 1024);
const frameUrl = URL.createObjectURL(frame);
```

`readRange` is chunk-aligned at the storage layer, so keep the chunk size in mind
when you request very small windows: a 1 KB read still pulls one whole chunk.

---

## Folder tree from facets

Folders are strings, so distinct values come from `facets()`.

```ts
const { byFolder, count } = await db.facets();

const tree = Object.entries(byFolder)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .reduce((roots, [path, n]) => {
    const parts = path.split('/').filter(Boolean);
    let node = roots;
    for (const part of parts) {
      node.children[part] ??= { children: {}, total: 0 };
      node = node.children[part];
      node.total += n;
    }
    return roots;
  }, { children: {}, total: count });

console.log(tree.children.photos?.total);
```

Counting only part of the library? Pass the same query you use for the list, and
the counts line up:

```ts
const facets = await db.facets({ where: { kind: 'image' }, search: 'holiday' });
```

---

## A trash view

`trash()` is reversible, so the delete button can undo.

```ts
async function renderTrash() {
  const page = await db.list({
    where: { deleted: true },
    sort: { by: 'deletedAt', order: 'desc' },
    limit: 100,
  });

  for (const record of page.items) {
    row(record, {
      restore: () => db.restore([record.id]).then(renderTrash),
      destroy: () => db.purge([record.id]).then(renderTrash),
    });
  }

  emptyButton.disabled = page.total === 0;
}

emptyButton.onclick = async () => {
  if (!confirm('Delete everything in the trash permanently?')) return;
  const removed = await db.emptyTrash();
  toast(`${removed} files deleted`);
  renderTrash();
};
```

Trash keeps the bytes, so a trashed 4 GB video still occupies 4 GB. Show
`stats().trashedSize` next to the empty-trash button so the cost is visible.

---

## Storage meter

```ts
async function renderStorage() {
  const stats = await db.stats();

  usedLabel.textContent = formatBytes(stats.size);
  filesLabel.textContent = `${stats.count} files`;

  // stats.quota is populated where navigator.storage.estimate() exists.
  if (stats.quota?.usage && stats.quota.quota) {
    const share = stats.quota.usage / stats.quota.quota;
    bar.style.width = `${(share * 100).toFixed(1)}%`;
    quotaLabel.textContent =
      `${formatBytes(stats.quota.usage)} of ${formatBytes(stats.quota.quota)} available`;
  }

  // Breakdown by kind, ready for a chart.
  for (const [kind, { count, size }] of Object.entries(stats.byKind)) {
    console.log(kind, count, formatBytes(size));
  }
}
```

Handle a full disk where it happens:

```ts
import { QuotaError } from 'idb-file-store';

try {
  await db.add(file);
} catch (error) {
  if (error instanceof QuotaError) {
    const trashed = (await db.stats()).trashedSize;
    toast(`Storage full. Emptying the trash would free ${formatBytes(trashed)}.`);
  }
}
```

---

## Backup and restore in the browser

```ts
backupButton.onclick = async () => {
  const backup = await db.backup();
  const json = JSON.stringify(backup, replacer);
  download(new Blob([json], { type: 'application/json' }), 'vault-backup.json');
};

// Blobs do not survive JSON.stringify, so encode them as data URLs.
function replacer(key, value) {
  return value instanceof Blob ? { __blob: value.type, data: toBase64(value) } : value;
}
```

Restoring is the mirror image. For large libraries, `snapshot()` is worth
preferring: it is metadata only, tiny, and JSON-safe as-is, which makes it good for
exporting a catalogue or diffing two databases.

```ts
restoreInput.onchange = async (event) => {
  const backup = JSON.parse(await event.target.files[0].text(), reviver);
  if (!confirm('Replace everything currently stored?')) return;

  await db.restoreBackup(backup, {
    replace: true,
    onProgress: (done, total) => (progress.textContent = `${done} / ${total}`),
  });
};
```

Note that previews are not part of a backup: they are derived data and can be
regenerated by re-adding the file, or simply requested lazily by the UI.

---

## Ask the browser to keep your data

IndexedDB is subject to eviction, especially on mobile and under storage
pressure. Ask for persistent storage once the user has committed to using your
app.

```ts
async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
```

Call it from a user gesture, such as a "Keep my files on this device" button.
Browsers grant it based on engagement, so treat the result as a hint rather than
a guarantee, and never treat local storage as a backup.

---

## Keep two tabs in sync

Changes made in one tab are broadcast to the others through `BroadcastChannel`.
The `remote` flag tells you the change did not originate here, which prevents
double-rendering.

```ts
db.on('change', ({ type, record, remote }) => {
  if (!remote) return;              // already reflected locally
  if (type === 'clear') return refreshAll();
  upsertInView(record);
});
```

Turn it off with `new FileDB({ name, syncTabs: false })` when an app is
single-tab by design.

---

## A paged list in React

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRecord } from 'idb-file-store';
import { db, ready } from './storage';

export function useFiles(query: Parameters<typeof db.list>[0]) {
  const [items, setItems] = useState<FileRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const resetKey = JSON.stringify(query);
  const request = useRef(0);

  const load = useCallback(
    async (next: string | null, append: boolean) => {
      await ready;
      const generation = ++request.current;

      setLoading(true);
      const page = await db.list({ ...query, cursor: next, limit: 24 });
      if (generation !== request.current) return;    // a newer query won

      setItems((previous) => (append ? [...previous, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setLoading(false);
    },
    [resetKey],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  return { items, loading, loadMore: cursor ? () => load(cursor, true) : null };
}
```

Two details that matter in a real app: a generation counter so a slow response
cannot overwrite a newer query, and `resetKey` to re-run when the query changes.

---

## Upload a whole directory

`<input type="file" webkitdirectory>` gives every file a relative path. Map it
into folders to rebuild the tree on upload.

```html
<input id="picker" type="file" webkitdirectory multiple />
```

```ts
picker.onchange = async (event) => {
  const files = Array.from(event.target.files ?? []);

  await db.importFiles(files, {
    preserveRelativePath: true,
    folder: '/imports',              // becomes /imports/<relative path>
    onProgress: (done, total) => (progress.value = done / total),
  });
};
```

A file at `holiday/2024/beach.jpg` lands in `/imports/holiday/2024` with the name
`beach.jpg`.

---

## Test against an in-memory database

`fake-indexeddb` gives you a real, spec-compliant IndexedDB in Node. Create a
fresh factory per test so nothing leaks between them.

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { FileDB } from 'idb-file-store';

function openDb() {
  return FileDB.open({
    name: `test-${Math.random()}`,
    indexedDB: new IDBFactory(),
    syncTabs: false,
  });
}

describe('uploads', () => {
  it('stores an image with tags', async () => {
    const db = await openDb();
    const record = await db.add(new Blob(['x'], { type: 'image/png' }), {
      name: 'pixel.png',
      tags: ['test'],
    });

    expect(record.kind).toBe('image');
    expect(await db.count({ where: { tags: ['test'] } })).toBe(1);
    db.close();
  });
});
```

Set `syncTabs: false` in tests so no `BroadcastChannel` is created, and inject the
factory so the database is isolated and disposable.
