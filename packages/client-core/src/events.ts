/**
 * @mara/client-core — tiny typed event emitter used by the client to notify
 * callback-style consumers (an alternative to subscribing to the Svelte stores).
 */
type Handler<T> = (payload: T) => void;

/** A tiny typed event emitter — no Node/DOM dependency, works everywhere. */
export class Emitter<Events> {
  private readonly handlers = new Map<keyof Events, Set<Handler<unknown>>>();

  /** Subscribe to `event`; returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<unknown>);
    return () => this.off(event, handler);
  }

  /** Subscribe for a single delivery; auto-unsubscribes before invoking the handler. */
  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Iterate a snapshot so a handler that unsubscribes itself (e.g. via once)
    // or adds another mid-dispatch can't corrupt the live set.
    for (const handler of [...set]) (handler as Handler<Events[K]>)(payload);
  }
}
