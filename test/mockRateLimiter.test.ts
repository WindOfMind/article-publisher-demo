import { MockRateLimiter } from '../src/infra/mockRateLimiter';

describe('MockRateLimiter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not decrement earlier keys when a later key is exhausted', () => {
    const limiter = new MockRateLimiter();

    expect(
      limiter.tryAcquireAll([{ key: 'b', limitRps: 1 }]),
    ).toBeNull();

    expect(
      limiter.tryAcquireAll([
        { key: 'a', limitRps: 1 },
        { key: 'b', limitRps: 1 },
      ]),
    ).toBe('b');

    // Key a must still have its token after the aborted multi-acquire.
    expect(limiter.tryAcquireAll([{ key: 'a', limitRps: 1 }])).toBeNull();
    expect(limiter.tryAcquireAll([{ key: 'a', limitRps: 1 }])).toBe('a');
  });

  it('returns the key immediately when limitRps is <= 0', () => {
    const limiter = new MockRateLimiter();

    expect(
      limiter.tryAcquireAll([{ key: 'zero', limitRps: 0 }]),
    ).toBe('zero');
    expect(
      limiter.tryAcquireAll([{ key: 'neg', limitRps: -1 }]),
    ).toBe('neg');
  });

  it('refills tokens on a new wall-clock second', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const limiter = new MockRateLimiter();
    expect(limiter.tryAcquire('k', 1)).toBe(true);
    expect(limiter.tryAcquire('k', 1)).toBe(false);

    jest.setSystemTime(new Date('2020-01-01T00:00:01.000Z'));
    expect(limiter.tryAcquire('k', 1)).toBe(true);
  });

  it('tryAcquire delegates to tryAcquireAll', () => {
    const limiter = new MockRateLimiter();
    expect(limiter.tryAcquire('solo', 2)).toBe(true);
    expect(limiter.tryAcquire('solo', 2)).toBe(true);
    expect(limiter.tryAcquire('solo', 2)).toBe(false);
  });

  it('clear resets all buckets', () => {
    const limiter = new MockRateLimiter();
    expect(limiter.tryAcquire('x', 1)).toBe(true);
    expect(limiter.tryAcquire('x', 1)).toBe(false);
    limiter.clear();
    expect(limiter.tryAcquire('x', 1)).toBe(true);
  });
});
