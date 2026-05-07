// Simple per-user token bucket. In-memory, per-instance.

interface Bucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /**
   * Returns true if the call is allowed.
   * `rpm` is the per-user limit; capacity equals `rpm` (allows 1-minute burst).
   */
  check(userId: string, rpm: number): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const refillPerMs = rpm / 60_000;

    let bucket = this.buckets.get(userId);
    if (!bucket || bucket.capacity !== rpm) {
      bucket = { tokens: rpm, lastRefill: now, capacity: rpm, refillPerMs };
      this.buckets.set(userId, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < 1) {
      const needed = 1 - bucket.tokens;
      return { allowed: false, retryAfterMs: Math.ceil(needed / refillPerMs) };
    }

    bucket.tokens -= 1;
    return { allowed: true };
  }

  reset(userId: string): void {
    this.buckets.delete(userId);
  }
}
