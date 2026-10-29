interface BucketState {
  tokens: number;
  /** Unix epoch second this bucket applies to. */
  second: number;
}

export interface RateLimitRequest {
  key: string;
  limitRps: number;
}

/**
 * In-memory token bucket rate limiter.
 * Keys are opaque (e.g. `tenant:…`, `platform:…`); each key gets `limitRps`
 * tokens that refill every wall-clock second.
 */
export class MockRateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  tryAcquire(key: string, limitRps: number): boolean {
    return this.tryAcquireAll([{ key, limitRps }]) === null;
  }

  /**
   * Atomically acquires one token from every bucket.
   * Returns the key of the first exhausted bucket, or `null` if all acquired.
   */
  tryAcquireAll(requests: RateLimitRequest[]): string | null {
    const nowSecond = Math.floor(Date.now() / 1000);
    const resolved: Array<{ key: string; bucket: BucketState }> = [];

    for (const { key, limitRps } of requests) {
      if (limitRps <= 0) {
        return key;
      }

      let bucket = this.buckets.get(key);
      if (bucket === undefined || bucket.second !== nowSecond) {
        bucket = { tokens: limitRps, second: nowSecond };
        this.buckets.set(key, bucket);
      }

      if (bucket.tokens <= 0) {
        return key;
      }

      resolved.push({ key, bucket });
    }

    for (const { bucket } of resolved) {
      bucket.tokens -= 1;
    }

    return null;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** Process-wide singleton shared across workers in the test harness. */
export const mockRateLimiter = new MockRateLimiter();
