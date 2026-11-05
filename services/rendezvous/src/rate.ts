/** Token buckets keyed by client address (or anything else). In memory only. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(capacity: number, perMinute: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.perMinute = perMinute;
    this.now = now;
  }

  take(key: string, cost = 1): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    if (this.buckets.size > 50_000) this.sweep(t);
    return true;
  }

  private sweep(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > 10 * 60_000) this.buckets.delete(k);
  }
}
