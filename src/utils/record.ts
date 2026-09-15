import { ValidationError } from '../errors.js';
import type { FileRecord, FileKind, JsonValue, ReadOptions } from '../types.js';
import type { StoredFile } from '../storage/records.js';
import { metadataToSearchText, normalizeFolder, normalizeMetadata } from './path.js';
import { kindFromMime } from './mime.js';
import { normalizeText } from './text.js';

/**
 * Translation between the on-disk {@link StoredFile} and the public
 * {@link FileRecord}, plus the derived fields the query engine relies on.
 */

/** Fields needed to (re)build the denormalised search columns. */
export interface SearchableSource {
  name: string;
  tags: readonly string[];
  folder: string;
  mime: string;
  notes: string;
  text: string;
  metadata: Record<string, JsonValue>;
}

/** The denormalised columns kept on every stored row to make querying cheap. */
export interface SearchColumns {
  nameLower: string;
  notesLower: string;
  textLower: string;
  tagsLower: string;
  metaText: string;
}

/**
 * Builds the lowercase and token columns.
 *
 * Each searchable field gets its own lowercase column so that `search.fields`
 * can restrict matching to a subset without re-reading the original values.
 * The ranker reads those columns directly, and the default "search everywhere"
 * path is simply the full set of them, so no merged copy is needed.
 */
export function buildSearchColumns(source: SearchableSource): SearchColumns {
  const nameLower = normalizeText(source.name);
  const notesLower = normalizeText(source.notes);
  const textLower = normalizeText(source.text);
  const tagsLower = normalizeText(source.tags.join(' '));
  const metaText = normalizeText(metadataToSearchText(source.metadata));

  return { nameLower, notesLower, textLower, tagsLower, metaText };
}

/** Normalises a tag list: trims, lowercases for matching but keeps display case. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      throw new ValidationError('Tags must be strings');
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length > 128) {
      throw new ValidationError('A record cannot hold more than 128 tags');
    }
  }
  return out;
}

/** Validates and trims a display name. */
export function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('File name cannot be empty');
  if (trimmed.length > 512) throw new ValidationError('File name cannot exceed 512 characters');
  if (/[\u0000-\u001f]/.test(trimmed)) {
    throw new ValidationError('File name cannot contain control characters');
  }
  return trimmed;
}

export function toPublicRecord(
  stored: StoredFile,
  options: {
    text?: string | undefined;
    blob?: Blob | undefined;
    thumbnail?: Blob | undefined;
  } = {},
): FileRecord {
  const record: FileRecord = {
    id: stored.id,
    name: stored.name,
    kind: stored.kind,
    mime: stored.mime,
    extension: stored.extension,
    size: stored.size,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    accessedAt: stored.accessedAt,
    hash: stored.hash,
    tags: [...stored.tags],
    folder: stored.folder,
    favorite: stored.favorite === 1,
    deleted: stored.deletedAt > 0,
    deletedAt: stored.deletedAt > 0 ? stored.deletedAt : null,
    notes: stored.notes,
    width: stored.width,
    height: stored.height,
    durationMs: stored.durationMs,
    chunkCount: stored.chunkCount,
    chunkSize: stored.chunkSize,
    metadata: stored.metadata,
    revision: stored.revision,
  };
  if (options.text !== undefined) record.text = options.text;
  if (options.blob !== undefined) record.blob = options.blob;
  if (options.thumbnail !== undefined) record.thumbnail = options.thumbnail;
  return record;
}

/** Merges read options with their defaults. */
export function resolveReadOptions(options: ReadOptions | undefined): Required<ReadOptions> {
  return {
    includeBlob: options?.includeBlob ?? false,
    includeText: options?.includeText ?? false,
    includeThumbnail: options?.includeThumbnail ?? false,
    touch: options?.touch ?? false,
  };
}

/** Normalises a folder for storage, rejecting invalid input. */
export function prepareFolder(folder: string | undefined): string {
  return normalizeFolder(folder);
}

/** Normalises metadata, raising a helpful error when it is not JSON-safe. */
export function prepareMetadata(metadata: Record<string, unknown> | undefined): Record<string, JsonValue> {
  return normalizeMetadata(metadata);
}

/** Derives the coarse kind, honouring an explicit override. */
export function resolveKind(explicit: FileKind | undefined, mime: string): FileKind {
  return explicit ?? kindFromMime(mime);
}