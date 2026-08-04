import { MexcFuturesSDK } from "../client";
import { Position } from "../types/account";
import { Logger } from "../utils/logger";
import { toFiniteNumber } from "../utils/numbers";
import { AccountSnapshot } from "./pnlMonitor";
import { SlTpStore, SlTpEntry } from "./slTpStore";

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

/** A pending STOP (entry) order, shown in the summary as a single line. */
export interface PendingOrderSummary {
  /** MEXC order ID */
  orderId: string;
  symbol: string;
  /** 1 = open long, 3 = open short */
  side: 1 | 3;
  /** Trigger price */
  triggerPrice: number;
  /** Volume (contracts) */
  vol: number;
  /** Leverage */
  leverage: number;
  /** Open type: 1 = isolated, 2 = cross */
  openType: 1 | 2;
}

/**
 * An alert fired while sampling when an open position has travelled more than
 * halfway from its entry toward its stop-loss or take-profit level.
 */
export interface PositionAlert {
  positionId: string;
  symbol: string;
  positionType: 1 | 2; // 1 = long, 2 = short
  leverage: number;
  /** Average open (entry) price */
  entry: number;
  /** Current price derived from unrealized PNL */
  currentPrice: number;
  /** Stop-loss price */
  sl: number;
  /** Take-profit price */
  tp: number;
  /** Which level the price is more than 50% of the way toward */
  target: "SL" | "TP";
  /** Fraction of the distance from entry toward the target already covered (0..1+) */
  progress: number;
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
  /** Pending (unfilled) STOP/entry orders, one line each in the summary. */
  pendingOrders: PendingOrderSummary[];
  account: AccountSnapshot;
}

export type OnPositionSummary = (summary: PositionSummary) => void;

export type OnPositionAlert = (alert: PositionAlert) => void;

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
  /** SL/TP levels per symbol, populated on order execution, for >50%-of-way alerts. */
  slTpStore: SlTpStore;
  /** Called once per position per target when >50% of the way toward SL/TP. */
  onAlert: OnPositionAlert;
  /** Days after which stale SL/TP entries are pruned (default LOG_RETENTION_DAYS). */
  slTpRetentionDays: number;
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
  private slTpStore: SlTpStore;
  private slTpRetentionMs: number;
  private onAlert: OnPositionAlert;
  private stats = new Map<string, PositionStats>();
  private sampleTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private sampling = false;
  /** Tracks which positions already alerted per target, to avoid repeat alerts. */
  private alerted = new Map<string, { sl: boolean; tp: boolean }>();

  constructor(opts: PositionSummaryMonitorOptions) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.baseCurrency = opts.baseCurrency;
    this.sampleIntervalMs = Math.max(opts.sampleIntervalSeconds, 5) * 1000;
    this.windowMs = Math.max(opts.windowHours, 1) * 3600 * 1000;
    this.intervalMs = Math.max(opts.intervalHours, 1) * 3600 * 1000;
    this.onSummary = opts.onSummary;
    this.slTpStore = opts.slTpStore;
    this.onAlert = opts.onAlert;
    this.slTpRetentionMs = Math.max(opts.slTpRetentionDays, 1) * 86400_000;
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
        const pnl = toFiniteNumber(p.unRealizedPnl);
        if (!Number.isFinite(pnl)) {
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

      // Evaluate >50%-toward-SL/TP alerts for positions with known targets.
      this.slTpStore.pruneStale(this.slTpRetentionMs);
      this.checkAlerts(active);
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
        const freshPnl = toFiniteNumber(p.unRealizedPnl);
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

      // Pending open (STOP) orders — fetched from the futures API, filtered to
      // entry-side orders. Failure to fetch degrades gracefully (empty list).
      let pendingOrders: PendingOrderSummary[] = [];
      try {
        const ores = await this.client.getOpenOrders();
        pendingOrders = this.extractPendingOrders(ores);
      } catch (error) {
        this.logger.debug(
          "⚠️ Could not fetch open orders for summary:",
          error instanceof Error ? error.message : error
        );
      }

      let account: AccountSnapshot;
      try {
        const asset = await this.client.getAccountAsset(this.baseCurrency);
        const inner: any = asset.data ?? asset;
        account = {
          availableBalance: toFiniteNumber(inner.availableBalance),
          equity: toFiniteNumber(inner.equity),
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
        pendingOrders,
        account,
      };

      this.logger.info(
        `📊 Emitting position summary: ${openPositions.length} open position(s), ` +
          `${pendingOrders.length} pending order(s)`
      );
      this.onSummary(summary);
    } catch (error) {
      this.logger.error(
        "❌ Failed to generate position summary:",
        error instanceof Error ? error.message : error
      );
    }
  }

  // ── Alert helpers ─────────────────────────────────────────────────

  /**
   * Parse the current-orders response into a list of pending STOP/entry
   * orders. Tolerates several response envelopes (`data` as array, or under
   * `currentOrders` / `list` / `orders`) and keeps only open-*entry* orders
   * (side 1 or 3) — i.e. the pending STOPs, not SL/TP closes.
   */
  private extractPendingOrders(res: any): PendingOrderSummary[] {
    const raw = res?.data;
    let list: any[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (Array.isArray(raw?.currentOrders)) list = raw.currentOrders;
    else if (Array.isArray(raw?.orders)) list = raw.orders;
    else if (Array.isArray(raw?.list)) list = raw.list;

    const out: PendingOrderSummary[] = [];
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const side = Number(o.side);
      if (side !== 1 && side !== 3) continue; // entry orders only

      const orderId = String(o.orderId ?? o.id ?? "");
      const symbol = String(o.symbol ?? "");
      const triggerPrice = toFiniteNumber(o.triggerPrice ?? o.stopPrice);
      const vol = toFiniteNumber(o.vol);
      if (!orderId || !symbol || !Number.isFinite(triggerPrice) || !Number.isFinite(vol) || vol <= 0) {
        continue;
      }

      out.push({
        orderId,
        symbol,
        side: side as 1 | 3,
        triggerPrice,
        vol,
        leverage: toFiniteNumber(o.leverage) || 0,
        openType: Number(o.openType) === 2 ? 2 : 1,
      });
    }
    return out;
  }

  /**
   * For each open position with a known SL/TP entry, evaluate whether the
   * price has moved more than 50% of the way toward the stop-loss or
   * take-profit level. Fires at most once per target per position lifetime.
   */
  private checkAlerts(active: Position[]): void {
    const seen = new Set<string>();
    for (const p of active) {
      const id = String(p.positionId);
      seen.add(id);
      const entry = this.slTpStore.get(p.symbol);
      if (!entry || entry.positionType !== p.positionType) continue;

      const alert = this.evaluateAlert(p, entry);
      if (!alert) continue;

      const key = alert.target.toLowerCase() as "sl" | "tp";
      const flags = this.alerted.get(id);
      if (flags && flags[key]) continue; // already alerted for this target

      this.alerted.set(id, {
        sl: flags?.sl || key === "sl",
        tp: flags?.tp || key === "tp",
      });
      this.logger.info(
        `🚨 ${alert.target} alert: ${p.symbol} ${Math.round(alert.progress * 100)}% of the way`
      );
      this.onAlert(alert);
    }
    // Drop alert flags for positions that are no longer open.
    for (const id of Array.from(this.alerted.keys())) {
      if (!seen.has(id)) this.alerted.delete(id);
    }
  }

  /**
   * Evaluate whether an open position is >50% of the way from entry toward
   * its SL or TP. Returns an alert payload, or null if neither threshold is
   * crossed.
   */
  private evaluateAlert(
    p: Position,
    entry: SlTpEntry
  ): PositionAlert | null {
    const avgEntry = p.openAvgPrice;
    const current = this.deriveCurrentPrice(p);
    if (
      !Number.isFinite(avgEntry) ||
      avgEntry <= 0 ||
      !Number.isFinite(current) ||
      current <= 0
    )
      return null;

    const isLong = p.positionType === 1;
    const { sl, tp } = entry;
    let target: "SL" | "TP" | null = null;
    let progress = 0;

    // Priority: SL first (more critical), then TP.
    if (isLong) {
      if (Number.isFinite(sl) && sl > 0 && sl < avgEntry) {
        const p = (avgEntry - current) / (avgEntry - sl);
        if (p > 0.5) {
          target = "SL";
          progress = p;
        }
      }
      if (!target && Number.isFinite(tp) && tp > 0 && tp > avgEntry) {
        const p = (current - avgEntry) / (tp - avgEntry);
        if (p > 0.5) {
          target = "TP";
          progress = p;
        }
      }
    } else {
      if (Number.isFinite(sl) && sl > 0 && sl > avgEntry) {
        const p = (current - avgEntry) / (sl - avgEntry);
        if (p > 0.5) {
          target = "SL";
          progress = p;
        }
      }
      if (!target && Number.isFinite(tp) && tp > 0 && tp < avgEntry) {
        const p = (avgEntry - current) / (avgEntry - tp);
        if (p > 0.5) {
          target = "TP";
          progress = p;
        }
      }
    }

    if (!target) return null;

    return {
      positionId: String(p.positionId),
      symbol: p.symbol,
      positionType: p.positionType,
      leverage: p.leverage,
      entry: avgEntry,
      currentPrice: current,
      sl,
      tp,
      target,
      progress: Math.min(progress, 9.99), // cap to avoid absurd values on extreme moves
    };
  }

  /**
   * Derive approximate current market price from unrealized PNL and the
   * position's remaining volume + average entry. Avoids an extra ticker API
   * call per position per poll.
   *
   *   LONG:  currentPrice = openAvgPrice + unRealizedPnl / holdVol
   *   SHORT: currentPrice = openAvgPrice - unRealizedPnl / holdVol
   */
  private deriveCurrentPrice(p: Position): number {
    const pnl = toFiniteNumber(p.unRealizedPnl);
    const vol = p.holdVol;
    if (!Number.isFinite(pnl) || !vol || vol <= 0) return NaN;
    return p.positionType === 1
      ? p.openAvgPrice + pnl / vol
      : p.openAvgPrice - pnl / vol;
  }

}
