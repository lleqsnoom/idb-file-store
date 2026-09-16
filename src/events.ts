/**
 * A tiny typed event emitter.
 *
 * The library avoids `EventTarget` so it works identically in browsers, workers
 * and Node, and so listeners can be typed against {@link FileDBEventMap}.
 */

/** Anything that can be used as an event map: a record of event names to payloads. */
export type EventMap = object;

/** A listener registered for a specific event. */
export type Listener<T> = (payload: T) => void;

/** Removes a previously registered listener. */
export type Unsubscribe = () => void;

/** Minimal typed pub/sub used by {@link FileDB}. */
export class Emitter<M extends EventMap> {
  readonly #listeners = new Map<keyof M, Set<Listener<never>>>();

  /** The returned function removes the listener again. */
  on<K extends keyof M>(event: K, listener: Listener<M[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof M>(event: K, listener: Listener<M[K]>): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  /** Omitting `listener` clears every listener for the event. */
  off<K extends keyof M>(event: K, listener?: Listener<M[K]>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    if (listener) set.delete(listener as Listener<never>);
    else set.clear();
    if (set.size === 0) this.#listeners.delete(event);
  }

  /** Emits `event`. Listener exceptions are isolated so one bad listener cannot break a write. */
  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<M[K]>)(payload);
      } catch (error) {
        reportListenerError(event, error);
      }
    }
  }

  /** Number of listeners registered for `event`. */
  listenerCount<K extends keyof M>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.#listeners.clear();
  }
}

function reportListenerError(event: string | number | symbol, error: unknown): void {
  const scope = globalThis as { console?: Console };
  scope.console?.error(`[idb-file-store] listener for "${String(event)}" threw`, error);
}