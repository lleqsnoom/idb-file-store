/**
 * idb-file-store playground.
 *
 * A complete little file manager built only on the public API: drag-and-drop
 * upload, faceted filters, live search, sorting, cursor pagination, inline
 * previews, tagging, favourites and a working trash.
 */

import {
  FILE_KINDS,
  FileDB,
  formatBytes,
  type FileKind,
  type FileRecord,
  type Query,
  type Sort,
  type SortField,
} from 'idb-file-store';

/* ------------------------------------------------------------------ dom --- */

function el<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`The playground markup is missing: ${selector}`);
  return found;
}

const dropZone = el<HTMLDivElement>('#drop');
const picker = el<HTMLInputElement>('#picker');
const filesGrid = el<HTMLDivElement>('#files');
const viewer = el<HTMLDialogElement>('#viewer');

const controls = {
  search: el<HTMLInputElement>('#search'),
  name: el<HTMLInputElement>('#f-name'),
  tag: el<HTMLSelectElement>('#f-tag'),
  folder: el<HTMLSelectElement>('#f-folder'),
  minSize: el<HTMLInputElement>('#f-size'),
  favorite: el<HTMLInputElement>('#f-favorite'),
  trash: el<HTMLInputElement>('#f-trash'),
  kinds: el<HTMLDivElement>('#kinds'),
  sort: el<HTMLSelectElement>('#sort'),
  limit: el<HTMLSelectElement>('#limit'),
  layout: el<HTMLButtonElement>('#layout'),
  more: el<HTMLButtonElement>('#more'),
  count: el<HTMLSpanElement>('#count'),
  emptyTrash: el<HTMLButtonElement>('#empty-trash'),
  sample: el<HTMLButtonElement>('#sample'),
  reset: el<HTMLButtonElement>('#reset'),
};

const stats = {
  count: el<HTMLElement>('#s-count'),
  size: el<HTMLElement>('#s-size'),
  physical: el<HTMLElement>('#s-physical'),
  trash: el<HTMLElement>('#s-trash'),
  quota: el<HTMLElement>('#s-quota'),
  meter: el<HTMLElement>('#s-meter'),
};

const viewerParts = {
  title: el<HTMLHeadingElement>('#v-title'),
  preview: el<HTMLDivElement>('#v-preview'),
  meta: el<HTMLDListElement>('#v-meta'),
  notes: el<HTMLInputElement>('#v-notes'),
  download: el<HTMLButtonElement>('#v-download'),
  favorite: el<HTMLButtonElement>('#v-favorite'),
  tag: el<HTMLButtonElement>('#v-tag'),
  rename: el<HTMLButtonElement>('#v-rename'),
  trash: el<HTMLButtonElement>('#v-trash'),
  close: el<HTMLButtonElement>('#v-close'),
};

/* ----------------------------------------------------------------- state -- */

const db = new FileDB({ name: 'idb-file-store-playground' });

const state = {
  search: '',
  name: '',
  kinds: new Set<FileKind>(),
  tag: '',
  folder: '',
  minSizeKb: '',
  favorite: false,
  trashed: false,
  sortBy: 'createdAt:desc',
  limit: 24,
  layout: 'grid' as 'grid' | 'list',
  cursor: null as string | null,
  open: null as FileRecord | null,
};

/** Object URLs handed to the DOM, revoked whenever the view is rebuilt. */
const liveUrls = new Set<string>();

function releaseUrls(): void {
  for (const url of liveUrls) db.revokeObjectURL(url);
  liveUrls.clear();
}

function objectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  return url;
}

/* ---------------------------------------------------------------- toast --- */

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = document.createElement('div');
  node.className = kind === 'error' ? 'toast error' : 'toast';
  node.textContent = message;
  el<HTMLDivElement>('#toasts').append(node);
  setTimeout(() => node.remove(), 3200);
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast(message, 'error');
  console.error(error);
}

/* ----------------------------------------------------------------- query -- */

function parseSort(value: string): Sort {
  const [by, order] = value.split(':');
  return { by: (by ?? 'createdAt') as SortField, order: order === 'asc' ? 'asc' : 'desc' };
}

function buildQuery(): Query {
  const where: Query['where'] = {
    deleted: state.trashed,
    ...(state.kinds.size > 0 ? { kind: [...state.kinds] } : {}),
    ...(state.tag ? { tags: [state.tag] } : {}),
    ...(state.folder ? { folder: state.folder } : {}),
    ...(state.favorite ? { favorite: true } : {}),
    ...(state.name ? { name: { contains: state.name } } : {}),
  };

  const minBytes = Number(state.minSizeKb);
  if (state.minSizeKb && Number.isFinite(minBytes) && minBytes > 0) {
    where.size = { gte: Math.round(minBytes * 1024) };
  }

  return {
    where,
    search: state.search || undefined,
    sort: parseSort(state.sortBy),
    limit: state.limit,
    cursor: state.cursor,
  };
}

/* ---------------------------------------------------------------- render -- */

let generation = 0;

async function refresh(append = false): Promise<void> {
  const current = ++generation;
  if (!append) state.cursor = null;

  try {
    const page = await db.list(buildQuery());
    if (current !== generation) return;

    state.cursor = page.nextCursor;

    if (append) {
      filesGrid.append(...page.items.map(card));
    } else {
      releaseUrls();
      filesGrid.replaceChildren(
        ...(page.items.length > 0 ? page.items.map(card) : [emptyState()]),
      );
    }

    controls.more.hidden = page.nextCursor === null;
    controls.count.textContent =
      page.total === 0
        ? 'No matching files'
        : `${page.items.length} of ${page.total} shown` +
          (page.hasMore ? ', more available' : '');

    void refreshSidebar();
  } catch (error) {
    fail(error);
  }
}

function emptyState(): HTMLElement {
  const node = document.createElement('div');
  node.className = 'empty';
  node.style.gridColumn = '1 / -1';
  node.textContent = state.trashed
    ? 'The trash is empty.'
    : 'Nothing here yet. Drop some files above.';
  return node;
}

function card(record: FileRecord): HTMLElement {
  const node = document.createElement('article');
  node.className = record.deleted ? 'card trashed' : 'card';
  node.append(cardThumbnail(record), cardDetails(record), cardActions(record));
  node.addEventListener('click', () => void openViewer(record));
  return node;
}

/** Preview slot, filled in later when a preview exists. */
function cardThumbnail(record: FileRecord): HTMLElement {
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.textContent = record.extension || record.kind;
  void fillThumbnail(record, thumb);
  return thumb;
}

/** Name plus a size, folder and tag summary. */
function cardDetails(record: FileRecord): HTMLElement {
  const meta = document.createElement('div');
  meta.className = 'meta';

  const name = document.createElement('strong');
  name.textContent = record.name;

  const { size, folder, tags } = record;
  const summary = [formatBytes(size), folder, tags.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join(' - ');

  const details = document.createElement('small');
  details.textContent = summary;

  meta.append(name, details);
  return meta;
}

/** Row actions. Clicks are stopped so they do not also open the viewer. */
function cardActions(record: FileRecord): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'actions';

  const star = document.createElement('button');
  star.type = 'button';
  star.title = 'Toggle favourite';
  star.className = record.favorite ? 'star-on' : '';
  star.textContent = record.favorite ? '★' : '☆';
  star.addEventListener('click', (event) => {
    event.stopPropagation();
    void run(async () => {
      await db.setFavorite([record.id], !record.favorite);
      await refresh();
    });
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = record.deleted ? 'Restore' : 'Trash';
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    void run(async () => {
      if (record.deleted) await db.restore([record.id]);
      else await db.trash([record.id]);
      await refresh();
    });
  });

  actions.append(star, remove);
  return actions;
}

async function fillThumbnail(record: FileRecord, target: HTMLElement): Promise<void> {
  if (record.kind !== 'image') return;
  try {
    const preview = (await db.getThumbnail(record.id)) ?? (await db.getBlob(record.id));
    // The grid may have been rebuilt while the preview was loading.
    if (!target.isConnected) return;
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = objectUrl(preview);
    target.replaceChildren(img);
  } catch {
    // Keep the textual placeholder when a preview cannot be produced.
  }
}

/* --------------------------------------------------------------- sidebar -- */

async function refreshSidebar(): Promise<void> {
  try {
    const [storage, facets] = await Promise.all([
      db.stats(),
      db.facets({ where: { deleted: state.trashed } }),
    ]);

    stats.count.textContent = String(storage.count);
    stats.size.textContent = formatBytes(storage.size);
    stats.physical.textContent = formatBytes(storage.physicalSize);
    stats.physical.title =
      storage.sharedBytes > 0
        ? `${formatBytes(storage.sharedBytes)} saved by records sharing identical content`
        : 'nothing shared yet';
    stats.trash.textContent = `${storage.trashedCount} (${formatBytes(storage.trashedSize)})`;
    controls.emptyTrash.disabled = storage.trashedCount === 0;

    if (storage.quota?.usage && storage.quota.quota) {
      const share = storage.quota.usage / storage.quota.quota;
      stats.quota.textContent = `${(share * 100).toFixed(1)}%`;
      stats.meter.style.width = `${Math.min(100, share * 100)}%`;
    } else {
      stats.quota.textContent = 'n/a';
      stats.meter.style.width = '0%';
    }

    syncOptions(controls.tag, Object.keys(facets.byTag).sort(), 'Any tag', state.tag);
    syncOptions(controls.folder, Object.keys(facets.byFolder).sort(), 'Any folder', state.folder);
  } catch (error) {
    fail(error);
  }
}

function syncOptions(
  select: HTMLSelectElement,
  values: readonly string[],
  placeholder: string,
  selected: string,
): void {
  const previous = select.value;
  select.replaceChildren(option('', placeholder), ...values.map((value) => option(value, value)));
  select.value = values.includes(selected) ? selected : previous && values.includes(previous) ? previous : '';
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function renderKindChips(): void {
  controls.kinds.replaceChildren(
    ...FILE_KINDS.map((kind) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = kind;
      chip.setAttribute('aria-pressed', String(state.kinds.has(kind)));
      chip.addEventListener('click', () => {
        if (state.kinds.has(kind)) state.kinds.delete(kind);
        else state.kinds.add(kind);
        chip.setAttribute('aria-pressed', String(state.kinds.has(kind)));
        void refresh();
      });
      return chip;
    }),
  );
}

/* --------------------------------------------------------------- viewer --- */

async function openViewer(record: FileRecord): Promise<void> {
  state.open = record;
  viewerParts.title.textContent = record.name;
  viewerParts.notes.value = record.notes;
  viewerParts.favorite.textContent = record.favorite ? 'Unfavourite' : 'Favourite';
  viewerParts.trash.textContent = record.deleted ? 'Restore' : 'Trash';

  viewerParts.meta.replaceChildren(
    ...[
      ['Kind', `${record.kind} (${record.mime})`],
      ['Size', `${formatBytes(record.size)} - ${record.chunkCount} chunk(s)`],
      ['Folder', record.folder],
      ['Tags', record.tags.join(', ') || 'none'],
      ['Created', new Date(record.createdAt).toLocaleString()],
      ['Updated', new Date(record.updatedAt).toLocaleString()],
      ['Hash', record.hash ?? 'not computed'],
      ['Revision', String(record.revision)],
    ].flatMap(([term, description]) => [
      Object.assign(document.createElement('dt'), { textContent: term }),
      Object.assign(document.createElement('dd'), { textContent: description }),
    ]),
  );

  viewer.showModal();
  await renderPreview(record);
}

async function renderPreview(record: FileRecord): Promise<void> {
  viewerParts.preview.replaceChildren(placeholder('Loading'));
  try {
    viewerParts.preview.replaceChildren(await previewNode(record));
  } catch (error) {
    viewerParts.preview.replaceChildren(placeholder('Preview failed'));
    fail(error);
  }
}

/** Picks the element that previews a record best. */
async function previewNode(record: FileRecord): Promise<HTMLElement> {
  if (record.kind === 'image') return imagePreview(record);
  if (record.kind === 'video') return videoPreview(record);
  if (record.kind === 'audio') return audioPreview(record);
  if (record.mime === 'application/pdf') return pdfPreview(record);
  if (record.kind === 'text' || record.kind === 'code') return textPreview(record);
  return placeholder('No preview for this type');
}

async function imagePreview(record: FileRecord): Promise<HTMLElement> {
  const image = document.createElement('img');
  image.alt = record.name;
  image.src = objectUrl(await db.getBlob(record.id));
  return image;
}

async function videoPreview(record: FileRecord): Promise<HTMLElement> {
  const video = document.createElement('video');
  video.controls = true;
  video.src = objectUrl(await db.getBlob(record.id));
  return video;
}

async function audioPreview(record: FileRecord): Promise<HTMLElement> {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = objectUrl(await db.getBlob(record.id));
  return audio;
}

async function pdfPreview(record: FileRecord): Promise<HTMLElement> {
  const frame = document.createElement('iframe');
  frame.title = record.name;
  frame.src = objectUrl(await db.getBlob(record.id));
  return frame;
}

async function textPreview(record: FileRecord): Promise<HTMLElement> {
  const pre = document.createElement('pre');
  pre.textContent = await db.getText(record.id);
  return pre;
}

function placeholder(text: string): HTMLElement {
  const node = document.createElement('p');
  node.textContent = text;
  return node;
}

/* ---------------------------------------------------------------- upload -- */

function ingest(files: readonly File[]): void {
  if (files.length === 0) return;
  void run(async () => {
    const records = await db.addMany(files, { folder: '/uploads', tags: ['uploaded'] });
    toast(`${records.length} file(s) stored`);
    await refresh();
  });
}

/* ------------------------------------------------------------ sample set -- */

const SAMPLES: ReadonlyArray<readonly [label: string, hue: number, tags: string[]]> = [
  ['sunset', 20, ['trip', 'sunset']],
  ['ocean', 200, ['trip', 'water']],
  ['forest', 130, ['trip', 'green']],
  ['desert', 45, ['trip', 'warm']],
];

function addSampleFiles(): void {
  void run(async () => {
    for (const [label, hue, tags] of SAMPLES) {
      const blob = await gradientImage(hue, label);
      await db.add(blob, {
        name: `${label}.jpg`,
        folder: '/samples',
        tags,
        notes: `generated gradient preview for "${label}"`,
        metadata: { generated: true, hue },
      });
    }

    await db.add(await toneWav(), {
      name: 'tone.wav',
      folder: '/samples',
      tags: ['audio'],
      durationMs: 1500,
    });

    await db.add(
      'packing list\n- passport\n- camera\n- tripod\n- beach towel\n',
      { name: 'checklist.txt', folder: '/samples', tags: ['notes'], notes: 'for the beach trip' },
    );

    toast('Sample files added');
    await refresh();
  });
}

async function gradientImage(hue: number, label: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 520;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, `hsl(${hue} 88% 58%)`);
  gradient.addColorStop(1, `hsl(${(hue + 55) % 360} 70% 22%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = 'rgba(255,255,255,0.85)';
  context.font = 'bold 56px ui-sans-serif, system-ui, sans-serif';
  context.fillText(label, 40, canvas.height - 48);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned nothing'))),
      'image/jpeg',
      0.9,
    );
  });
}

/** Builds a short 16-bit PCM sine wave so the demo has real playable audio. */
async function toneWav(): Promise<Blob> {
  const sampleRate = 16_000;
  const seconds = 1.5;
  const samples = Math.floor(sampleRate * seconds);
  const data = new DataView(new ArrayBuffer(44 + samples * 2));

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) data.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  data.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  ascii(36, 'data');
  data.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(1, i / 400) * Math.min(1, (samples - i) / 400);
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * envelope;
    data.setInt16(44 + i * 2, Math.round(value * 0x7fff * 0.7), true);
  }

  return new Blob([data.buffer], { type: 'audio/wav' });
}

/* --------------------------------------------------------------- actions -- */

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    fail(error);
  }
}

/** Wires the whole page. Each group below owns one region of the UI. */
function wireEvents(): void {
  wireUpload();
  wireFilters();
  wireToolbar();
  wireViewer();
  wireDatabaseEvents();
}

/** Drop zone, hidden file input and drag feedback. */
function wireUpload(): void {
  const accept = (files: FileList | null): void => {
    if (files) ingest(Array.from(files));
  };

  dropZone.addEventListener('click', () => picker.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') picker.click();
  });
  picker.addEventListener('change', () => {
    accept(picker.files);
    picker.value = '';
  });

  for (const type of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add('hot');
    });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    dropZone.addEventListener(type, () => dropZone.classList.remove('hot'));
  }
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    accept(event.dataTransfer?.files ?? null);
  });
}

/** Search and filter fields, debounced so typing does not thrash IndexedDB. */
function wireFilters(): void {
  let debounce = 0;
  const refilter = (): void => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void refresh(), 180);
  };
  const onText = (assign: () => void): void => {
    assign();
    refilter();
  };
  const onChoice = (assign: () => void): void => {
    assign();
    void refresh();
  };

  controls.search.addEventListener('input', () =>
    onText(() => (state.search = controls.search.value.trim())),
  );
  controls.name.addEventListener('input', () =>
    onText(() => (state.name = controls.name.value.trim())),
  );
  controls.minSize.addEventListener('input', () =>
    onText(() => (state.minSizeKb = controls.minSize.value.trim())),
  );
  controls.tag.addEventListener('change', () => onChoice(() => (state.tag = controls.tag.value)));
  controls.folder.addEventListener('change', () =>
    onChoice(() => (state.folder = controls.folder.value)),
  );
  controls.favorite.addEventListener('change', () =>
    onChoice(() => (state.favorite = controls.favorite.checked)),
  );
  controls.trash.addEventListener('change', () =>
    onChoice(() => (state.trashed = controls.trash.checked)),
  );
}

/** Sort, page size, layout and the bulk-action buttons. */
function wireToolbar(): void {
  controls.sort.addEventListener('change', () => {
    state.sortBy = controls.sort.value;
    void refresh();
  });
  controls.limit.addEventListener('change', () => {
    state.limit = Number(controls.limit.value);
    void refresh();
  });
  controls.layout.addEventListener('click', () => {
    state.layout = state.layout === 'grid' ? 'list' : 'grid';
    filesGrid.classList.toggle('list', state.layout === 'list');
    controls.layout.textContent = state.layout === 'grid' ? 'Grid' : 'List';
  });
  controls.more.addEventListener('click', () => void refresh(true));
  controls.sample.addEventListener('click', () => addSampleFiles());

  controls.emptyTrash.addEventListener('click', () => {
    void run(async () => {
      const removed = await db.emptyTrash();
      toast(`${removed} file(s) deleted for good`);
      await refresh();
    });
  });
  controls.reset.addEventListener('click', () => {
    if (!confirm('Delete every stored file? This cannot be undone.')) return;
    void run(async () => {
      await db.clear();
      toast('Everything erased');
      await refresh();
    });
  });
}

/** Runs an action against the record currently open in the viewer. */
function withOpenRecord(action: (record: FileRecord) => Promise<void>): void {
  const record = state.open;
  if (record) void run(() => action(record));
}

/** The preview dialog: frame behaviour, then the actions inside it. */
function wireViewer(): void {
  wireViewerChrome();
  wireViewerActions();
}

/** Closing the dialog and the bookkeeping that goes with it. */
function wireViewerChrome(): void {
  viewerParts.close.addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => {
    state.open = null;
    releaseUrls();
    void refresh();
  });
  viewerParts.notes.addEventListener('change', () =>
    withOpenRecord(async (record) => {
      await db.update(record.id, { notes: viewerParts.notes.value });
      toast('Note saved');
    }),
  );
}

/** Download, favourite, rename, tag and trash for the open record. */
function wireViewerActions(): void {
  viewerParts.download.addEventListener('click', () =>
    withOpenRecord((record) => db.download(record.id)),
  );

  viewerParts.favorite.addEventListener('click', () =>
    withOpenRecord(async (record) => {
      await db.setFavorite([record.id], !record.favorite);
      viewer.close();
    }),
  );

  viewerParts.rename.addEventListener('click', () => {
    const next = prompt('New name', state.open?.name ?? '');
    if (!next) return;
    withOpenRecord(async (record) => {
      await db.update(record.id, { name: next });
      viewer.close();
    });
  });

  viewerParts.tag.addEventListener('click', () => {
    const next = prompt('Add a tag', 'favourite');
    if (!next) return;
    withOpenRecord(async (record) => {
      await db.setTags(record.id, { add: [next] });
      viewer.close();
    });
  });

  viewerParts.trash.addEventListener('click', () =>
    withOpenRecord(async (record) => {
      if (record.deleted) await db.restore([record.id]);
      else await db.trash([record.id]);
      viewer.close();
    }),
  );
}

/** Reflects writes made in another tab. */
function wireDatabaseEvents(): void {
  db.on('change', ({ remote }) => {
    if (remote) void refresh();
  });
}

/* ------------------------------------------------------------------ boot -- */

async function main(): Promise<void> {
  renderKindChips();
  wireEvents();
  await db.open();
  await refresh();
}

void main().catch(fail);
