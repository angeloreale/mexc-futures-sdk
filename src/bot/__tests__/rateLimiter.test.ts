import { TokenBucket } from "../../utils/rateLimiter";

/**
 * Yield to the microtask queue so Promise callbacks queued by a just-resolved
 * waiter run. (Can't use setImmediate here — jest's fake timers mock it.)
 */
const flush = () => Promise.resolve();

describe("TokenBucket", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("fires a burst up to capacity with zero delay (as fast as possible)", async () => {
    const bucket = new TokenBucket({ capacity: 3, intervalMs: 1000 });

    let done = 0;
    const p1 = bucket.acquire().then(() => done++);
    const p2 = bucket.acquire().then(() => done++);
    const p3 = bucket.acquire().then(() => done++);

    await Promise.all([p1, p2, p3]);
    // No timers were advanced, yet all three resolved — burst path is immediate.
    expect(done).toBe(3);
    expect(bucket.availableTokens).toBe(0);
  });

  it("queues requests beyond capacity and releases one per intervalMs (FIFO)", async () => {
    const bucket = new TokenBucket({ capacity: 1, intervalMs: 100 });

    const order: number[] = [];
    const p1 = bucket.acquire().then(() => order.push(1));
    const p2 = bucket.acquire().then(() => order.push(2));
    const p3 = bucket.acquire().then(() => order.push(3));

    await p1; // immediate (burst of 1)
    expect(order).toEqual([1]);
    expect(bucket.availableTokens).toBe(0);

    // Before the first refill, nothing else should proceed.
    jest.advanceTimersByTime(99);
    await flush();
    expect(order).toEqual([1]);

    // First refill → second request proceeds.
    jest.advanceTimersByTime(1);
    await flush();
    expect(order).toEqual([1, 2]);

    // Next refill → third request proceeds.
    jest.advanceTimersByTime(100);
    await flush();
    expect(order).toEqual([1, 2, 3]);

    await Promise.all([p2, p3]);
  });

  it("never fires faster than one request per intervalMs once the burst is spent", async () => {
    const bucket = new TokenBucket({ capacity: 2, intervalMs: 250 });
    const releasedAt: number[] = [];

    const p1 = bucket.acquire().then(() => releasedAt.push(Date.now()));
    const p2 = bucket.acquire().then(() => releasedAt.push(Date.now()));
    const p3 = bucket.acquire().then(() => releasedAt.push(Date.now()));
    const p4 = bucket.acquire().then(() => releasedAt.push(Date.now()));

    await Promise.all([p1, p2]);
    // Burst of 2 fired immediately.
    expect(releasedAt.length).toBe(2);

    jest.advanceTimersByTime(250);
    await flush();
    expect(releasedAt.length).toBe(3);

    jest.advanceTimersByTime(250);
    await flush();
    expect(releasedAt.length).toBe(4);

    await Promise.all([p3, p4]);
  });

  it("rejects a waiter whose maxWaitMs deadline elapses", async () => {
    const bucket = new TokenBucket({
      capacity: 1,
      intervalMs: 1000,
      maxWaitMs: 300,
    });

    await bucket.acquire(); // consume the only token

    const p = bucket.acquire();
    jest.advanceTimersByTime(300);
    await expect(p).rejects.toThrow(/timed out waiting for a rate-limit token/);

    // Drain the still-pending refill timer so no handles linger.
    jest.advanceTimersByTime(1000);
    await flush();
  });

  it("exposes token availability for diagnostics", () => {
    const bucket = new TokenBucket({ capacity: 2, intervalMs: 1000 });
    expect(bucket.canAcquire()).toBe(true);
    expect(bucket.availableTokens).toBe(2);

    bucket.acquire();
    expect(bucket.availableTokens).toBe(1);
  });

  it("clamps invalid capacity/interval to safe minimums", () => {
    const bucket = new TokenBucket({ capacity: 0, intervalMs: 0 });
    expect(bucket.availableTokens).toBe(1); // capacity clamped to 1
    // intervalMs clamped to 1ms — refill after 1ms.
    bucket.acquire();
    expect(bucket.availableTokens).toBe(0);
    jest.advanceTimersByTime(1);
    expect(bucket.availableTokens).toBe(1);
  });
});
