import { MexcFuturesSDK } from "../client";
import { Position } from "../types/account";
import { Logger } from "../utils/logger";
import { AccountSnapshot } from "./pnlMonitor";

/** A single unrealized-PNL sample for one position. */
interface PnlSample {
  ts: number;
  pnl: number;
}

/** Rolling per-position state kept between summary emissions. */
interface PositionStats {
  positionId: string;
  symbol: string;
  positionType: 1 | 2;
  openType: 1 | 2;
  leverage: number;
  openAvgPrice: number;
  margin: number;
  samples: PnlSample[];
}

/** An open position with its PNL stats over the summary window. */
export interface OpenPositionSummary {
  positionId: string;
  symbol: string;
  positionType: 1 | 2; // 1 = long, 2 = short
  openType: 1 | 2;
  leverage: number;
  openAvgPrice: number;
  /** Current unrealized PNL in quote currency */
  currentPnl: number;
  /** Highest unrealized PNL observed within the window */
  maxPnl: number;
  /** Lowest unrealized PNL observed within the window */
  minPnl: number;
  /** Initial margin of the position */
  margin: number;
}

/** Full data payload produced on each summary emission. */
export interface PositionSummary {
  /** Trailing window (hours) over which PNL max/min was tracked */
  windowHours: number;
  /** Reporting cadence (hours) */
  intervalHours: number;
  /** Unix ms when the summary was generated */
  generatedAt: number;
  openPositions: OpenPositionSummary[];
  account: AccountSnapshot;
}

export type OnPositionSummary = (summary: PositionSummary) => void;

export interface PositionSummaryMonitorOptions {
  client: MexcFuturesSDK;
  logger: Logger;
  baseCurrency: string;
  /** How often (seconds) unrealized PNL is sampled to track max/min (min 5) */
  sampleIntervalSeconds: number;
  /** Trailing window (hours) for PNL max/min stats */
  windowHours: number;
  /** How often (hours) the summary is emitted */
  intervalHours: number;
  /** Called each time a summary is ready to be sent */
  onSummary: OnPositionSummary;
}

/**
 * Continuously samples unrealized PNL of every open position (using the
 * `unRealizedPnl` field returned by MEXC's open-positions endpoint) and keeps
 * a rolling max/min per position over a trailing window. On a fixed cadence it
 * assembles a summary of:
 *   - currently open positions + their current / max / min PNL
 *   - the account's available balance and equity
 *
 * Both timers are unref'd so they never keep the process alive on their own.
 */
export class PositionSummaryMonitor {
  private client: MexcFuturesSDK;
  private logger: Logger;
  private baseCurrency: string;
  private windowMs: number;
  private intervalMs: number;
  private sampleIntervalMs: number;
  private onSummary: OnPositionSummary;
  private stats = new Map<string, PositionStats>();
  private sampleTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private sampling = false;

  constructor(opts: PositionSummaryMonitorOptions) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.baseCurrency = opts.baseCurrency;
    this.sampleIntervalMs = Math.max(opts.sampleIntervalSeconds, 5) * 1000;
    this.windowMs = Math.max(opts.windowHours, 1) * 3600 * 1000;
    this.intervalMs = Math.max(opts.intervalHours, 1) * 3600 * 1000;
    this.onSummary = opts.onSummary;
  }

  /** Start sampling and schedule summary emissions. */
  start(): void {
    if (this.sampleTimer || this.summaryTimer) return;
    this.logger.info(
      `📊 Position summary monitor started ` +
        `(window ${this.windowMs / 3600000}h, emit every ${this.intervalMs / 3600000}h)`
    );
    void this.sample();
    this.sampleTimer = setInterval(() => void this.sample(), this.sampleIntervalMs);
    if (this.sampleTimer.unref) this.sampleTimer.unref();

    this.summaryTimer = setInterval(() => void this.emitSummary(), this.intervalMs);
    if (this.summaryTimer.unref) this.summaryTimer.unref();
  }

  /** Stop both timers. */
  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  /**
   * Sample unrealized PNL for every open position and update the rolling
   * max/min window. Public so tests can drive it directly.
   */
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const res = await this.client.getOpenPositions();
      const positions: Position[] = Array.isArray(res.data) ? res.data : [];
      const now = Date.now();
      const seen = new Set<string>();
      const active = positions.filter((p) => p.state !== 3 && p.holdVol > 0);

      for (const p of active) {
        const id = String(p.positionId);
        seen.add(id);
        const pnl = p.unRealizedPnl;
        if (typeof pnl !== "number" || !Number.isFinite(pnl)) {
          // Some positions (e.g. airdrops) may omit unRealizedPnl — skip sampling.
          continue;
        }

        let st = this.stats.get(id);
        if (!st) {
          st = {
            positionId: id,
            symbol: p.symbol,
            positionType: p.positionType,
            openType: p.openType,
            leverage: p.leverage,
            openAvgPrice: p.openAvgPrice,
            margin: p.oim || p.im || 0,
            samples: [],
          };
          this.stats.set(id, st);
        } else {
          // Refresh metadata in case it changed (e.g. partial close adjusted it).
          st.symbol = p.symbol;
          st.positionType = p.positionType;
          st.openType = p.openType;
          st.leverage = p.leverage;
          st.openAvgPrice = p.openAvgPrice;
          st.margin = p.oim || p.im || 0;
        }
        st.samples.push({ ts: now, pnl });
      }

      // Prune samples older than the window and drop positions no longer open.
      const cutoff = now - this.windowMs;
      for (const [id, st] of this.stats) {
        st.samples = st.samples.filter((s) => s.ts >= cutoff);
        if (!seen.has(id) || st.samples.length === 0) {
          this.stats.delete(id);
        }
      }
    } catch (error) {
      this.logger.warn(
        "⚠️ Position summary sampling failed:",
        error instanceof Error ? error.message : error
      );
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Assemble and emit the summary. Public so tests can drive it directly.
   */
  async emitSummary(): Promise<void> {
    try {
      // Fresh open positions so the summary always reflects the current state,
      // merging in the tracked PNL stats (max/min) where available.
      const res = await this.client.getOpenPositions();
      const positions: Position[] = Array.isArray(res.data) ? res.data : [];
      const open = positions.filter((p) => p.state !== 3 && p.holdVol > 0);

      const openPositions: OpenPositionSummary[] = open.map((p) => {
        const id = String(p.positionId);
        const st = this.stats.get(id);
        // Prefer the freshest value from this fetch for "current"; the tracked
        // samples (rolling window) provide the max/min PNL reached.
        const freshPnl =
          typeof p.unRealizedPnl === "number" && Number.isFinite(p.unRealizedPnl)
            ? p.unRealizedPnl
            : NaN;
        let currentPnl = freshPnl;
        let maxPnl = freshPnl;
        let minPnl = freshPnl;

        if (st && st.samples.length > 0) {
          if (!Number.isFinite(currentPnl)) {
            currentPnl = st.samples[st.samples.length - 1].pnl;
          }
          let hi = -Infinity;
          let lo = Infinity;
          for (const s of st.samples) {
            if (s.pnl > hi) hi = s.pnl;
            if (s.pnl < lo) lo = s.pnl;
          }
          maxPnl = hi;
          minPnl = lo;
        }

        return {
          positionId: id,
          symbol: p.symbol,
          positionType: p.positionType,
          openType: p.openType,
          leverage: p.leverage,
          openAvgPrice: p.openAvgPrice,
          currentPnl,
          maxPnl,
          minPnl,
          margin: p.oim || p.im || 0,
        };
      });

      let account: AccountSnapshot;
      try {
        const asset = await this.client.getAccountAsset(this.baseCurrency);
        const inner: any = asset.data ?? asset;
        account = {
          availableBalance: inner.availableBalance ?? NaN,
          equity: inner.equity ?? NaN,
          currency: this.baseCurrency,
        };
      } catch (error) {
        this.logger.error(
          "❌ Failed to fetch account snapshot for summary:",
          error instanceof Error ? error.message : error
        );
        account = {
          availableBalance: NaN,
          equity: NaN,
          currency: this.baseCurrency,
        };
      }

      const summary: PositionSummary = {
        windowHours: this.windowMs / 3600000,
        intervalHours: this.intervalMs / 3600000,
        generatedAt: Date.now(),
        openPositions,
        account,
      };

      this.logger.info(
        `📊 Emitting position summary: ${openPositions.length} open position(s)`
      );
      this.onSummary(summary);
    } catch (error) {
      this.logger.error(
        "❌ Failed to generate position summary:",
        error instanceof Error ? error.message : error
      );
    }
  }

}
