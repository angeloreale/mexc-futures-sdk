import { MexcFuturesSDK } from "../client";
import { Logger } from "../utils/logger";
import {
  TradeSignal,
  TrackedSignal,
  SignalResolutionEvent,
} from "./types";
import { normalizeSymbol } from "./parser";
import { ContractResolver } from "./resolver";

/**
 * Monitors signals posted to resolver channels.
 *
 * Does NOT trade — instead polls MEXC tickers and posts a resolution update
 * when the price reaches the signal's TP or SL level.
 */
export class SignalResolver {
  private client: MexcFuturesSDK;
  private resolver: ContractResolver;
  private logger: Logger;
  private intervalSeconds: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Active signals being tracked, keyed by unique ID. */
  private signals = new Map<string, TrackedSignal>();

  /** Called when a TP or SL is hit. */
  private onResolution: (event: SignalResolutionEvent) => void;

  constructor(params: {
    client: MexcFuturesSDK;
    resolver: ContractResolver;
    logger: Logger;
    intervalSeconds: number;
    onResolution: (event: SignalResolutionEvent) => void;
  }) {
    this.client = params.client;
    this.resolver = params.resolver;
    this.logger = params.logger;
    this.intervalSeconds = params.intervalSeconds;
    this.onResolution = params.onResolution;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Start the polling loop. Safe to call multiple times (no-op if already running).
   */
  start(): void {
    if (this.intervalId) return;
    this.logger.info(
      `🔍 Signal Resolver started — polling every ${this.intervalSeconds}s`
    );
    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.intervalSeconds * 1000);
  }

  /**
   * Stop the polling loop. Safe to call multiple times.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.info("🔍 Signal Resolver stopped");
    }
  }

  /**
   * Accept a parsed signal from a resolver channel and start tracking it.
   * Resolves market entries (entry=0) from the current ticker price.
   */
  async track(signal: TradeSignal): Promise<void> {
    // 1. Normalize symbol
    const mexcSymbol = normalizeSymbol(signal.rawSymbol);
    if (!mexcSymbol) {
      this.logger.warn(
        `🔍 Resolver: cannot normalize symbol "${signal.rawSymbol}" — skipping`
      );
      return;
    }

    // 2. Verify the contract exists
    const contract = await this.resolver.resolve(mexcSymbol);
    if (!contract) {
      this.logger.warn(
        `🔍 Resolver: symbol ${mexcSymbol} not tradable — skipping`
      );
      return;
    }

    // 3. Resolve entry price for market signals
    let entry = signal.entry;
    if (signal.orderType === "market" || entry <= 0) {
      try {
        const ticker = await this.client.getTicker(mexcSymbol);
        entry = ticker?.data?.lastPrice ?? 0;
        if (!entry || entry <= 0) {
          this.logger.error(
            `🔍 Resolver: could not resolve market price for ${mexcSymbol}`
          );
          return;
        }
        this.logger.info(
          `🔍 Resolver: market entry resolved ${mexcSymbol} @ ${entry}`
        );
      } catch (error) {
        this.logger.error(
          `🔍 Resolver: failed to fetch ticker for ${mexcSymbol}:`,
          error instanceof Error ? error.message : error
        );
        return;
      }
    }

    // 4. Round prices to contract precision
    const priceScale = contract.priceScale || 0;
    const pFactor = Math.pow(10, priceScale);
    const roundPrice = (p: number) =>
      priceScale > 0 ? Math.round(p * pFactor) / pFactor : p;

    const roundedEntry = roundPrice(entry);
    const roundedSl = roundPrice(signal.sl);

    // 5. Normalize TP targets (borrow default TP ratio from config is not
    //    available here, so we only track explicit TPs — multi-TP signals
    //    must include at least one TP).
    const tps = signal.tp.map(roundPrice).filter((tp) => {
      if (signal.action === "BUY" && tp <= roundedEntry) return false;
      if (signal.action === "SELL" && tp >= roundedEntry) return false;
      return true;
    });

    if (tps.length === 0 && signal.tp.length > 0) {
      this.logger.warn(
        `🔍 Resolver: all TPs for ${mexcSymbol} are on the wrong side of entry — skipping`
      );
      return;
    }

    // 6. Validate SL direction
    if (signal.action === "BUY" && roundedSl >= roundedEntry) {
      this.logger.warn(
        `🔍 Resolver: SL ${roundedSl} >= entry ${roundedEntry} for LONG ${mexcSymbol} — skipping`
      );
      return;
    }
    if (signal.action === "SELL" && roundedSl <= roundedEntry) {
      this.logger.warn(
        `🔍 Resolver: SL ${roundedSl} <= entry ${roundedEntry} for SHORT ${mexcSymbol} — skipping`
      );
      return;
    }

    // 7. Create tracked signals — one per unique chatId+messageId combo
    const chatId = String(signal.chatId ?? "0");
    const messageId = signal.messageId ?? 0;
    const createdAt = signal.timestamp ? signal.timestamp * 1000 : Date.now();

    // If the signal has no explicit TPs, track with empty TPs (will only check SL)
    const allTps = tps.length > 0
      ? tps
      : []; // no TPs — only SL monitoring

    const id = `${chatId}_${messageId}`;
    if (this.signals.has(id)) {
      this.logger.debug(`🔍 Resolver: signal ${id} already tracked — skipping`);
      return;
    }

    const tracked: TrackedSignal = {
      id,
      symbol: signal.rawSymbol,
      mexcSymbol,
      action: signal.action,
      entry: roundedEntry,
      sl: roundedSl,
      tps: allTps,
      chatId,
      messageId,
      createdAt,
    };

    this.signals.set(id, tracked);
    this.logger.info(
      `🔍 Resolver: tracking ${mexcSymbol} ${signal.action} entry=${roundedEntry} SL=${roundedSl} TPs=[${allTps.join(",")}] (id=${id})`
    );
  }

  /**
   * Number of signals currently being tracked.
   */
  get activeCount(): number {
    return this.signals.size;
  }

  // ── Polling ───────────────────────────────────────────────────────────

  /**
   * Poll tickers for all tracked symbols and check for TP/SL hits.
   */
  private async poll(): Promise<void> {
    if (this.signals.size === 0) return;

    // Collect unique symbols to fetch
    const symbols = [...new Set([...this.signals.values()].map((s) => s.mexcSymbol))];

    // Fetch tickers (one request per symbol to stay within rate limits;
    // the SDK's built-in rate limiter handles spacing).
    const tickers = new Map<string, number>();
    for (const symbol of symbols) {
      try {
        const ticker = await this.client.getTicker(symbol);
        const price = ticker?.data?.lastPrice ?? 0;
        if (price > 0) {
          tickers.set(symbol, price);
        }
      } catch (error) {
        this.logger.warn(
          `🔍 Resolver: ticker fetch failed for ${symbol}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    if (tickers.size === 0) return;

    // Check each tracked signal against its ticker
    const resolved: string[] = [];

    for (const [id, signal] of this.signals) {
      const price = tickers.get(signal.mexcSymbol);
      if (!price || price <= 0) continue;

      const isLong = signal.action === "BUY";

      // Check SL first (SL hit = immediate resolution, ignore TPs)
      const slHit = isLong ? price <= signal.sl : price >= signal.sl;
      if (slHit) {
        resolved.push(id);
        this.logger.info(
          `🛑 Resolver: SL hit for ${signal.mexcSymbol} ${signal.action} — price=${price} SL=${signal.sl}`
        );
        this.onResolution({
          type: "sl",
          signal,
          hitPrice: price,
        });
        continue;
      }

      // Check each TP level
      for (let i = 0; i < signal.tps.length; i++) {
        const tp = signal.tps[i];
        const tpHit = isLong ? price >= tp : price <= tp;
        if (tpHit) {
          resolved.push(id);
          this.logger.info(
            `🎯 Resolver: TP${i + 1} hit for ${signal.mexcSymbol} ${signal.action} — price=${price} TP=${tp}`
          );
          this.onResolution({
            type: "tp",
            signal,
            hitPrice: price,
            tpIndex: i,
          });
          break; // first TP hit resolves the signal
        }
      }
    }

    // Remove resolved signals
    for (const id of resolved) {
      this.signals.delete(id);
    }
  }
}
