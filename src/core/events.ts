export type Handler<T = unknown> = (payload: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on<T = unknown>(topic: string, h: Handler<T>): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(h as Handler);
    return () => set!.delete(h as Handler);
  }

  async emit<T = unknown>(topic: string, payload: T): Promise<void> {
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const h of [...set]) await h(payload);
  }
}
