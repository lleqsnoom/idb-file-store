import { ValidationError } from '../errors.js';
import type { FileInput, FileKind, JsonValue } from '../types.js';
import type { StoredFile, StoredThumbnail } from './records.js';
import { normalizeChunkSize } from './chunk-store.js';
import { contentHash } from '../utils/hash.js';
import { extensionOf, mimeFromName, readTextPreview, withExtension } from '../utils/mime.js';
import { inputName, now, toBlob, toTimestamp } from '../utils/misc.js';
import type { SearchColumns } from '../utils/record.js';
import {
  buildSearchColumns,
  normalizeName,
  normalizeTags,
  prepareFolder,
  prepareMetadata,
  resolveKind,
} from '../utils/record.js';
import { generateThumbnail, readImageDimensions } from '../utils/thumbnail.js';

/**
 * Write preparation.
 *
 * Everything that must happen before bytes reach IndexedDB lives here: detecting
 * the type, hashing, reading text out of the payload, rendering a preview, and
 * assembling the row. Keeping it out of the database class matters because none
 * of it may run inside a transaction. Decoding, hashing and canvas work all yield
 * to the event loop, and a transaction that yields commits, so these steps have
 * to finish first.
 */

/** The subset of database options this pipeline reads. */
export interface PrepareConfig {
  chunkSize: number;
  extractText: boolean;
  maxTextBytes: number;
  generateThumbnails: boolean;
  thumbnailMaxSize: number;
  computeHash: boolean;
  hashMaxBytes: number;
}

/**
 * Fields the pipeline reads while preparing a write.
 *
 * Both `AddOptions` and `UpdateOptions` satisfy this shape, which lets one path
 * serve `add()`, `addMany()` and `update({ data })`.
 */
export interface PrepareOptions {
  name?: string;
  mime?: string;
  kind?: FileKind;
  tags?: string[];
  folder?: string;
  favorite?: boolean;
  notes?: string;
  metadata?: Record<string, JsonValue>;
  createdAt?: number | Date;
  updatedAt?: number | Date;
  text?: string | null;
  extractText?: boolean;
  generateThumbnail?: boolean;
  chunkSize?: number;
  computeHash?: boolean;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

/** A payload and its row, ready to be written in one transaction. */
export interface PreparedWrite {
  blob: Blob;
  chunkSize: number;
  thumbnail: StoredThumbnail | null;
  row: Omit<StoredFile, 'id' | 'chunkCount' | 'chunkSize'>;
}

/** A rendered preview plus the size of the image it came from. */
interface Preview {
  width?: number;
  height?: number;
  thumbnail: StoredThumbnail | null;
}

/**
 * Runs the full preparation pipeline for one payload.
 *
 * Hashing, text extraction and preview rendering are independent, so they run
 * together rather than in sequence.
 */
export async function prepareWrite(
  input: FileInput,
  options: PrepareOptions,
  id: string,
  config: PrepareConfig,
): Promise<PreparedWrite> {
  const blob = toBlob(input, options.mime);
  const bareName = resolveBareName(input, options);
  const mime = resolveMimeFor(options.mime, input, bareName);
  const name = normalizeName(withExtension(bareName, mime));
  const kind = resolveKind(options.kind, mime);

  const [hash, text, preview] = await Promise.all([
    hashPayload(blob, options, config),
    extractText(blob, mime, options, config),
    buildPreview(blob, kind, options, config, id),
  ]);

  return {
    blob,
    chunkSize: normalizeChunkSize(options.chunkSize ?? config.chunkSize),
    thumbnail: preview.thumbnail,
    row: buildStoredRow({ name, mime, kind, size: blob.size, hash, text, preview, options }),
  };
}

/** Everything the row needs once detection has run. */
interface RowInput {
  name: string;
  mime: string;
  kind: FileKind;
  size: number;
  hash: string | null;
  text: string;
  preview: Preview;
  options: PrepareOptions;
}

/** The row shape this module produces. */
type StoredRow = Omit<StoredFile, 'id' | 'chunkCount' | 'chunkSize'>;

/**
 * Values derived once from a payload and its options.
 *
 * Computing them here keeps each field group below a pure projection of the same
 * inputs, so no group can normalize a tag or a folder differently from another.
 */
interface RowContext {
  input: RowInput;
  createdAt: number;
  tags: string[];
  folder: string;
  notes: string;
  metadata: Record<string, JsonValue>;
  columns: SearchColumns;
}

/** Maps a prepared payload onto its storage row. Pure: same input, same row. */
function buildStoredRow(input: RowInput): StoredRow {
  const context = rowContext(input);
  return {
    ...identityFields(context),
    ...timestampFields(context),
    ...placementFields(context),
    ...contentFields(context),
  };
}

function rowContext(input: RowInput): RowContext {
  const { options } = input;
  const tags = normalizeTags(options.tags);
  const folder = prepareFolder(options.folder);
  const notes = options.notes ?? '';
  const metadata = prepareMetadata(options.metadata);

  return {
    input,
    createdAt: toTimestamp(options.createdAt) ?? now(),
    tags,
    folder,
    notes,
    metadata,
    columns: buildSearchColumns({
      name: input.name,
      tags,
      folder,
      mime: input.mime,
      notes,
      text: input.text,
      metadata,
    }),
  };
}

/** What the payload is: identity, type, size and the content hash. */
function identityFields(context: RowContext): Pick<
  StoredRow,
  'name' | 'nameLower' | 'kind' | 'mime' | 'extension' | 'size' | 'hash' | 'revision'
> {
  const { input } = context;
  return {
    name: input.name,
    nameLower: context.columns.nameLower,
    kind: input.kind,
    mime: input.mime,
    extension: extensionOf(input.name),
    size: input.size,
    hash: input.hash,
    revision: 1,
  };
}

/** Creation, modification and last-read times. */
function timestampFields(
  context: RowContext,
): Pick<StoredRow, 'createdAt' | 'updatedAt' | 'accessedAt'> {
  const { options } = context.input;
  return {
    createdAt: context.createdAt,
    updatedAt: toTimestamp(options.updatedAt) ?? context.createdAt,
    accessedAt: context.createdAt,
  };
}

/** Where the record sits and how it is flagged. */
function placementFields(
  context: RowContext,
): Pick<
  StoredRow,
  'tags' | 'tagsLower' | 'folder' | 'favorite' | 'deletedAt' | 'width' | 'height' | 'durationMs'
> {
  const { options, preview } = context.input;
  return {
    tags: context.tags,
    tagsLower: context.columns.tagsLower,
    folder: context.folder,
    favorite: options.favorite ? 1 : 0,
    deletedAt: 0,
    width: options.width ?? preview.width ?? null,
    height: options.height ?? preview.height ?? null,
    durationMs: options.durationMs ?? null,
  };
}

/** What the record says, including the indexed text columns. */
function contentFields(
  context: RowContext,
): Pick<
  StoredRow,
  'notes' | 'notesLower' | 'text' | 'textLower' | 'metaText' | 'metadata'
> {
  const { columns } = context;
  return {
    notes: context.notes,
    notesLower: columns.notesLower,
    text: context.input.text,
    textLower: columns.textLower,
    metaText: columns.metaText,
    metadata: context.metadata,
  };
}

/** The name an input would produce, before the extension is appended. */
function resolveBareName(input: FileInput, options: PrepareOptions): string {
  const provided = options.name ?? inputName(input);
  if (provided !== undefined && provided.trim() === '') {
    throw new ValidationError('File name cannot be empty');
  }
  return (provided ?? 'untitled').trim();
}

/**
 * Decides a payload's MIME type.
 *
 * Precedence is the explicit option, then the type the browser attached to a real
 * `File`/`Blob`, then the file extension. Synthesised blobs (from strings and
 * buffers) carry no meaningful type, which is why the input itself is inspected
 * rather than the blob that wraps it.
 */
function resolveMimeFor(explicit: string | undefined, input: unknown, name: string): string {
  const declared = explicit || (input instanceof Blob ? input.type : '');
  if (declared) return declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return mimeFromName(name);
}

/** Hashes the payload unless the caller turned it off or it exceeds the ceiling. */
async function hashPayload(
  blob: Blob,
  options: PrepareOptions,
  config: PrepareConfig,
): Promise<string | null> {
  const wanted = options.computeHash ?? config.computeHash;
  if (!wanted || blob.size > config.hashMaxBytes) return null;
  return contentHash(blob);
}

/** Reads searchable text out of text-like payloads. */
async function extractText(
  blob: Blob,
  mime: string,
  options: PrepareOptions,
  config: PrepareConfig,
): Promise<string> {
  if (options.text !== undefined && options.text !== null) return options.text;
  const wanted = options.extractText ?? config.extractText;
  if (!wanted) return '';
  return readTextPreview(blob, mime, config.maxTextBytes);
}

/** Measures and renders an image payload. */
async function buildPreview(
  blob: Blob,
  kind: FileKind,
  options: PrepareOptions,
  config: PrepareConfig,
  id: string,
): Promise<Preview> {
  if (kind !== 'image') return { thumbnail: null };

  const wanted = options.generateThumbnail ?? config.generateThumbnails;
  const generated = wanted ? await generateThumbnail(blob, { maxSize: config.thumbnailMaxSize }) : null;
  if (generated) {
    return {
      width: generated.sourceWidth,
      height: generated.sourceHeight,
      thumbnail: {
        id,
        blob: generated.blob,
        width: generated.width,
        height: generated.height,
        createdAt: now(),
      },
    };
  }

  // Rendering a preview already decodes the source, so only fall back to a
  // separate decode when there is no preview to read the size from.
  const measured = await readImageDimensions(blob);
  return { ...(measured ?? {}), thumbnail: null };
}
