import { Logger } from "./logger";

export interface TokenBucketOptions {
  /** Maximum burst capacity — how many requests can be sent immediately (>= 1). */
  capacity: number;
  /** Milliseconds to replenish one token. Sustained rate ≈ 1000/intervalMs req/s. */
  intervalMs: number;
  /** Optional max time (ms) to wait for a token before rejecting. 0 = wait indefinitely (default). */
  maxWaitMs?: number;
  /** Optional logger for throttling diagnostics. */
  logger?: Logger;
  /** Optional label used in log lines (e.g. "mexc-api"). */
  name?: string;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * A fair token-bucket rate limiter.
 *
 * - Requests that can proceed immediately do so — bursts of up to `capacity`
 *   fire back-to-back with ZERO delay ("as fast as possible").
 * - Once the burst is consumed, further requests are queued FIFO and released
 *   one per `intervalMs` (sustained rate ≈ 1000/intervalMs req/s), so callers
 *   never exceed the configured limit and never get dropped (unless `maxWaitMs`
 *   expires).
 *
 * This is the right tool for "place orders ASAP but stay within rate limits":
 * it adds delay ONLY when the budget is actually exhausted, and even then only
 * the minimum spacing required — unlike a fixed `sleep(n)` between every order,
 * which would slow down traffic that never needed throttling.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly maxWaitMs: number;
  private readonly logger?: Logger;
  private readonly name: string;
  private tokens: number;
  private lastRefill: number;
  private readonly waiters: Waiter[] = [];
  private refillTimer: NodeJS.Timeout | null = null;

  constructor(options: TokenBucketOptions) {
    this.capacity = Math.max(1, Math.floor(options.capacity));
    this.intervalMs = Math.max(1, Math.floor(options.intervalMs));
    this.maxWaitMs =
      options.maxWaitMs && options.maxWaitMs > 0 ? options.maxWaitMs : 0;
    this.logger = options.logger;
    this.name = options.name ?? "token-bucket";
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /** Current number of available tokens (fractional). */
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /** True if a token can be acquired right now without waiting. */
  canAcquire(): boolean {
    return this.availableTokens >= 1;
  }

  /**
   * Wait until a token is available, then consume one.
   * Resolves immediately when the bucket has tokens (the burst/ASAP path).
   */
  acquire(): Promise<void> {
    this.refill();

    // Fast path: token available and nobody queued ahead of us → fire immediately.
    if (this.tokens >= 1 && this.waiters.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    // Budget exhausted — queue FIFO behind anyone already waiting.
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };
      if (this.maxWaitMs > 0) {
        waiter.timer = setTimeout(() => this.expireWaiter(waiter), this.maxWaitMs);
      }
      this.waiters.push(waiter);
      this.scheduleRefill();
    });
  }

  /** Replenish tokens based on elapsed time since the last refill. */
  private refill(): void {
    const now = Date.now();
    if (now < this.lastRefill + this.intervalMs) return;
    const elapsed = now - this.lastRefill;
    const gained = Math.floor(elapsed / this.intervalMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefill += gained * this.intervalMs;
      this.logger?.debug(
        `[${this.name}] refilled +${gained} → ${this.tokens}/${this.capacity}`
      );
    }
  }

  /** Arm the timer that refills the bucket at the next interval boundary. */
  private scheduleRefill(): void {
    if (this.refillTimer) return;
    const nextRefill = this.lastRefill + this.intervalMs;
    const delay = Math.max(0, nextRefill - Date.now());
    this.refillTimer = setTimeout(() => {
      this.refillTimer = null;
      this.refill();
      this.serveWaiters();
      // Keep re-arming while there are still queued waiters with no token yet.
      if (this.waiters.length > 0 && this.tokens < 1) {
        this.scheduleRefill();
      }
    }, delay);
  }

  /** Hand out tokens to queued waiters in FIFO order. */
  private serveWaiters(): void {
    while (this.tokens >= 1 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.tokens -= 1;
      this.logger?.debug(
        `[${this.name}] released token → ${this.tokens}/${this.capacity}`
      );
      waiter.resolve();
    }
  }

  /** Remove and reject a waiter whose max-wait deadline elapsed. */
  private expireWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx === -1) return;
    this.waiters.splice(idx, 1);
    waiter.reject(
      new Error(
        `[${this.name}] timed out waiting for a rate-limit token after ${this.maxWaitMs}ms`
      )
    );
  }
}
