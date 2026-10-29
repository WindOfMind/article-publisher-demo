interface BucketState {
  tokens: number;
  /** Unix epoch second this bucket applies to. */
  second: number;
}

/**
 * In-memory per-tenant token bucket rate limiter.
 * Each tenant gets `limitRps` tokens that refill every wall-clock second.
 */
export class MockRateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  tryAcquire(tenantId: string, limitRps: number): boolean {
    if (limitRps <= 0) {
      return false;
    }

    const nowSecond = Math.floor(Date.now() / 1000);
    let bucket = this.buckets.get(tenantId);

    if (bucket === undefined || bucket.second !== nowSecond) {
      bucket = { tokens: limitRps, second: nowSecond };
      this.buckets.set(tenantId, bucket);
    }

    if (bucket.tokens <= 0) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** Process-wide singleton shared across workers in the test harness. */
export const mockRateLimiter = new MockRateLimiter();
