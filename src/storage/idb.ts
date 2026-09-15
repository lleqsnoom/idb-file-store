import { NotSupportedError } from '../errors.js';

/**
 * Promise wrappers around the callback-based IndexedDB API.
 *
 * Keeping this in one place means every other module can `await` raw requests
 * and still participate in the same transaction, which is what makes multi-step
 * writes atomic.
 */

/** Waits for a single IndexedDB request. */
export function waitForRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction commits, rejects when it aborts or errors. */
export function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Transaction failed'));
  });
}

/** Signature of the helper handed to {@link runTransaction} callbacks. */
export type Wait = typeof waitForRequest;

/** Options for {@link openDatabase}. */
export interface OpenOptions {
  /** Database name. */
  name: string;
  /** Schema version. */
  version: number;
  /** Runs inside `onupgradeneeded`. */
  upgrade: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction) => void;
  /** Factory to use. Defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  /** Called when another tab holds an older version open. */
  onBlocked?: (event: Event) => void;
  /** Called when another tab requests a version change; the db is closed first. */
  onVersionChange?: () => void;
}

/** Opens (and upgrades) the database. */
export function openDatabase(options: OpenOptions): Promise<IDBDatabase> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(
      new NotSupportedError(
        'IndexedDB is not available in this environment. Pass `indexedDB` in the options to inject one.',
      ),
    );
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(options.name, options.version);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      try {
        options.upgrade(db, event.oldVersion, request.transaction as IDBTransaction);
      } catch (error) {
        request.transaction?.abort();
        reject(error);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        options.onVersionChange?.();
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error('Failed to open the database'));
    request.onblocked = (event) => options.onBlocked?.(event);
  });
}

/** Deletes a whole database. */
export function deleteDatabase(name: string, factory?: IDBFactory): Promise<void> {
  const target = factory ?? globalThis.indexedDB;
  if (!target) return Promise.reject(new NotSupportedError('IndexedDB is not available'));

  return new Promise<void>((resolve, reject) => {
    const request = target.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete "${name}"`));
    request.onblocked = () =>
      reject(
        new NotSupportedError(
          `Deleting "${name}" is blocked because other tabs still hold it open. Close them and retry.`,
        ),
      );
  });
}

/**
 * Runs `body` inside a transaction and commits it.
 *
 * `body` must only await IndexedDB requests issued through the provided `wait`
 * helper. Awaiting anything else (a `fetch`, a timer) lets the browser commit
 * the transaction early and later requests will throw `TransactionInactiveError`.
 */
export async function runTransaction<T>(
  db: IDBDatabase,
  storeNames: string | readonly string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction, wait: Wait) => T | Promise<T>,
): Promise<T> {
  const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
  const transaction = db.transaction(names, mode);
  const done = waitForTransaction(transaction);
  // Prevent an unhandled rejection when `body` fails before the transaction settles.
  done.catch(() => undefined);

  try {
    const result = await body(transaction, waitForRequest);
    await done;
    return result;
  } catch (error) {
    abortQuietly(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

/** Aborts a transaction, ignoring the error raised when it already settled. */
export function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Already finished; nothing to do.
  }
}

/** Collects every record from a store request into an array. */
export function collectFromCursor<T>(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null,
  direction: IDBCursorDirection = 'next',
  limit = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const out: T[] = [];
    if (limit <= 0) {
      resolve(out);
      return;
    }
    const request = source.openCursor(query, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.value as T);
      if (out.length >= limit) {
        resolve(out);
        return;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Cursor failed'));
  });
}

