/**
 * Error hierarchy for `idb-file-store`.
 *
 * Every error thrown by the library extends {@link FileDBError}, so a single
 * `instanceof` check is enough to tell library errors apart from platform ones.
 */

/** Base class for every error thrown by the library. */
export class FileDBError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when a requested record does not exist. */
export class NotFoundError extends FileDBError {}

/** Thrown when input fails validation (bad name, negative size, bad query, ...). */
export class ValidationError extends FileDBError {}

/** Thrown when an operation is attempted on a closed or unopened database. */
export class ClosedError extends FileDBError {}

/** Thrown when the runtime lacks a feature the operation needs. */
export class NotSupportedError extends FileDBError {}

/** Thrown when the browser refuses a write because the storage quota is full. */
export class QuotaError extends FileDBError {}

/** Thrown when a write conflicts with an existing record under a unique constraint. */
export class ConflictError extends FileDBError {}

const QUOTA_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

/** Wraps a low-level IndexedDB failure, translating quota errors into {@link QuotaError}. */
export function wrapIdbError(cause: unknown, context: string): FileDBError {
  if (cause instanceof FileDBError) return cause;

  const name = readErrorName(cause);
  const detail = readErrorMessage(cause);
  const message = detail ? `${context}: ${detail}` : context;

  if (QUOTA_NAMES.has(name)) return new QuotaError(message, { cause });
  return new FileDBError(message, { cause });
}

function readErrorName(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    const value = (cause as { name?: unknown }).name;
    if (typeof value === 'string') return value;
  }
  return '';
}

function readErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return '';
}