import type { FileKind } from '../types.js';

/**
 * MIME and extension helpers.
 *
 * The mapping is intentionally small but covers the formats people actually
 * drop into a file manager. Unknown types fall back to `application/octet-stream`
 * and the `other` kind.
 */

const EXTENSION_TO_MIME: Record<string, string> = {
  // text
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  rtf: 'application/rtf',
  // code
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  json: 'application/json',
  jsonc: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  swift: 'text/x-swift',
  sql: 'text/x-sql',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  weba: 'audio/webm',
  // documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  pages: 'application/vnd.apple.pages',
  epub: 'application/epub+zip',
  // spreadsheets
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  numbers: 'application/vnd.apple.numbers',
  // presentations
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  key: 'application/vnd.apple.keynote',
  // archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

const KIND_BY_MIME_TOP_LEVEL: Record<string, FileKind> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  font: 'font',
};

const KIND_BY_MIME: Record<string, FileKind> = {
  'application/pdf': 'document',
  'application/rtf': 'document',
  'application/epub+zip': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.oasis.opendocument.text': 'document',
  'application/vnd.apple.pages': 'document',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet': 'spreadsheet',
  'application/vnd.apple.numbers': 'spreadsheet',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
  'application/vnd.oasis.opendocument.presentation': 'presentation',
  'application/vnd.apple.keynote': 'presentation',
  'application/zip': 'archive',
  'application/gzip': 'archive',
  'application/x-tar': 'archive',
  'application/x-bzip2': 'archive',
  'application/x-xz': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/vnd.rar': 'archive',
};

const CODE_MIME_PATTERN =
  /(javascript|typescript|json|xml|yaml|toml|x-shellscript|x-python|x-ruby|x-go|x-rust|x-java|x-kotlin|x-c|x-c\+\+|x-csharp|x-php|x-swift|x-sql)/;

/** The extension without the dot, lowercased, or an empty string when there is none. */
export function extensionOf(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Last path segment, ignoring trailing slashes. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Guesses a MIME type from a file name. Falls back to `application/octet-stream`. */
export function mimeFromName(name: string): string {
  return EXTENSION_TO_MIME[extensionOf(name)] ?? 'application/octet-stream';
}

const PREFERRED_EXTENSION_BY_MIME: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'text/typescript': 'ts',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
};

/** Canonical file extension for a MIME type, or an empty string when unknown. */
export function extensionFromMime(mime: string): string {
  const normalized = normalizeMime(mime);
  const preferred = PREFERRED_EXTENSION_BY_MIME[normalized];
  if (preferred) return preferred;
  for (const [extension, candidate] of Object.entries(EXTENSION_TO_MIME)) {
    if (candidate === normalized) return extension;
  }
  return '';
}

/** Appends the canonical extension when `name` does not already carry one. */
export function withExtension(name: string, mime: string): string {
  if (extensionOf(name)) return name;
  const extension = extensionFromMime(mime);
  return extension ? `${name}.${extension}` : name;
}

/** Maps a MIME type to a coarse {@link FileKind}. */
export function kindFromMime(mime: string): FileKind {
  const normalized = normalizeMime(mime);
  const topLevel = normalized.split('/')[0] ?? '';
  const byTopLevel = KIND_BY_MIME_TOP_LEVEL[topLevel];
  if (byTopLevel) return byTopLevel;

  const exact = KIND_BY_MIME[normalized];
  if (exact) return exact;

  if (topLevel === 'text') {
    return CODE_MIME_PATTERN.test(normalized) ? 'code' : 'text';
  }
  if (topLevel === 'application') {
    if (CODE_MIME_PATTERN.test(normalized)) return 'code';
    if (normalized.includes('xml') || normalized.includes('yaml')) return 'code';
  }
  return 'other';
}

/** Lowercases a MIME type and drops parameters such as `; charset=utf-8`. */
export function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** `true` when the payload can be decoded as text for search indexing. */
export function isTextLikeMime(mime: string): boolean {
  const normalized = normalizeMime(mime);
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/xml' ||
    normalized === 'application/yaml' ||
    normalized === 'application/toml' ||
    normalized === 'application/x-ndjson' ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml')
  );
}

/**
 * Decodes the first `maxBytes` of a blob as UTF-8 text. Returns an empty string
 * when the payload is not text-like.
 */
export async function readTextPreview(
  blob: Blob,
  mime: string,
  maxBytes: number,
): Promise<string> {
  if (!isTextLikeMime(mime) || maxBytes <= 0) return '';
  const slice = blob.size > maxBytes ? blob.slice(0, maxBytes) : blob;
  try {
    const raw = await slice.text();
    return stripControlCharacters(raw);
  } catch {
    return '';
  }
}

function stripControlCharacters(input: string): string {
  // Keep tab, newline and carriage return; drop the rest of the C0/C1 range.
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ');
}