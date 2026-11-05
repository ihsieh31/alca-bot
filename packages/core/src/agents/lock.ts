/**
 * One holder per key at a time, first come first served. A bot's router is a
 * single engine conversation, so its turns (from any thread) take turns.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, Array<() => void>>();

  acquire(key: string): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.tails.set(key, mine);
    const queue = this.releases.get(key) ?? [];
    queue.push(release);
    this.releases.set(key, queue);
    return prev;
  }

  release(key: string): void {
    const queue = this.releases.get(key);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.releases.delete(key);
    next?.();
  }

  busy(key: string): boolean {
    return (this.releases.get(key)?.length ?? 0) > 0;
  }
}
