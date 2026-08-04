import * as fs from "fs";
import * as path from "path";
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

/** A pending order shown as a single line in the summary. */
export interface PendingOrderSummary {
  /** MEXC order ID */
  orderId: string;
  symbol: string;
  /** 1=open long, 2=close short (TP/SL), 3=open short, 4=close long (TP/SL) */
  side: 1 | 2 | 3 | 4;
  /** "STOP" = trigger entry, "TP_SL" = attached take-profit/stop-loss pair. */
  kind: "STOP" | "TP_SL";
  /** 1 = fires when price >= triggerPrice, 2 = fires when price <= triggerPrice (STOP). */
  triggerType: 1 | 2;
  /** Trigger price (STOP). */
  triggerPrice: number;
  /** Take-profit price (TP_SL). */
  takeProfitPrice: number;
  /** Stop-loss price (TP_SL). */
  stopLossPrice: number;
  /** Position direction for TP_SL: 1 = long, 2 = short. */
  positionType: 1 | 2;
  /** Volume (contracts). */
  vol: number;
  /** Leverage (STOP entries). */
  leverage: number;
  /** Open type: 1 = isolated, 2 = cross. */
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
  /** JSON file where per-position min/max PNL stats are persisted across restarts. */
  statsFilePath: string;
  /** Days to retain persisted stats (default LOG_RETENTION_DAYS). */
  statsRetentionDays: number;
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
  private statsFilePath: string;
  private statsRetentionMs: number;
  private lastStatsSave = 0;
  private savingStats = false;
  private readonly STATS_SAVE_THROTTLE_MS = 5000;

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
    this.statsFilePath = opts.statsFilePath;
    this.statsRetentionMs = Math.max(opts.statsRetentionDays, 1) * 86400_000;
    this.loadStats();
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

  /** Stop both timers and flush persisted stats. */
  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
    this.persistStats(true);
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

      // Persist the tracked stats (throttled) so a restart doesn't lose them.
      this.persistStats();

      if (this.logger.isDebugEnabled()) {
        this.logger.debug(
          `📊 Polled ${active.length} open position(s) · tracking ${this.stats.size} PNL stat(s)`
        );
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

      // Pending orders: untriggered STOP entries (planorder/list/orders) plus
      // uncompleted TP/SL pairs (stoporder/list/orders). Each call fails
      // independently and degrades gracefully (that section is just omitted).
      let pendingOrders: PendingOrderSummary[] = [];
      try {
        const results = await Promise.allSettled([
          this.client.getPlanOrders(undefined, 1), // 1 = untriggered
          this.client.getStopOrders(undefined, 0), // 0 = uncompleted
        ]);
        if (results[0].status === "fulfilled") {
          pendingOrders.push(...this.extractPlanOrders(results[0].value));
        } else {
          this.logger.debug(
            "⚠️ Could not fetch trigger orders for summary:",
            results[0].reason instanceof Error ? results[0].reason.message : results[0].reason
          );
        }
        if (results[1].status === "fulfilled") {
          pendingOrders.push(...this.extractStopOrders(results[1].value));
        } else {
          this.logger.debug(
            "⚠️ Could not fetch TP/SL orders for summary:",
            results[1].reason instanceof Error ? results[1].reason.message : results[1].reason
          );
        }
      } catch (error) {
        this.logger.debug(
          "⚠️ Could not fetch pending orders for summary:",
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

  // ── Persistence helpers ───────────────────────────────────────────

  /**
   * Load persisted per-position PNL stats from disk so min/max tracking
   * survives a restart. Entries with no activity within the retention window
   * are dropped, and samples outside the trailing max/min window are pruned
   * (same semantics as live sampling).
   */
  private loadStats(): void {
    try {
      if (!fs.existsSync(this.statsFilePath)) return;
      const raw = fs.readFileSync(this.statsFilePath, "utf-8");
      const data = JSON.parse(raw);
      const list: any[] = Array.isArray(data?.stats) ? data.stats : [];
      const now = Date.now();

      for (const s of list) {
        if (!s || typeof s.positionId !== "string") continue;
        const samples: PnlSample[] = Array.isArray(s.samples)
          ? s.samples
              .filter(
                (x: any) => x && typeof x.ts === "number" && Number.isFinite(x.pnl)
              )
              .map((x: any) => ({ ts: x.ts, pnl: x.pnl }))
          : [];
        // Retention: drop positions with no activity within the retention period.
        const lastTs = samples.length
          ? Math.max(...samples.map((x) => x.ts))
          : 0;
        if (now - lastTs > this.statsRetentionMs) continue;

        this.stats.set(String(s.positionId), {
          positionId: String(s.positionId),
          symbol: String(s.symbol ?? ""),
          positionType: s.positionType === 2 ? 2 : 1,
          openType: s.openType === 2 ? 2 : 1,
          leverage: toFiniteNumber(s.leverage) || 0,
          openAvgPrice: toFiniteNumber(s.openAvgPrice),
          margin: toFiniteNumber(s.margin) || 0,
          samples,
        });
      }

      // Apply the trailing window pruning on load (consistent with live sampling).
      const cutoff = now - this.windowMs;
      for (const [id, st] of this.stats) {
        st.samples = st.samples.filter((x) => x.ts >= cutoff);
        if (st.samples.length === 0) this.stats.delete(id);
      }

      if (this.stats.size > 0) {
        this.logger.info(
          `📂 Restored ${this.stats.size} position stats from ${this.statsFilePath}`
        );
      }
    } catch (error) {
      this.logger.warn(
        "⚠️ Could not load persisted position stats — starting fresh:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Persist the tracked per-position stats to disk. Throttled to avoid disk
   * churn on the sampling cadence; pass `force` to bypass the throttle (used
   * on shutdown).
   */
  private persistStats(force = false): void {
    if (this.savingStats) return;
    const now = Date.now();
    if (!force && now - this.lastStatsSave < this.STATS_SAVE_THROTTLE_MS) return;
    this.lastStatsSave = now;
    this.savingStats = true;
    try {
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        stats: Array.from(this.stats.values()),
      };
      const dir = path.dirname(this.statsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statsFilePath, JSON.stringify(data), "utf-8");
    } catch (error) {
      this.logger.warn(
        "⚠️ Could not persist position stats:",
        error instanceof Error ? error.message : error
      );
    } finally {
      this.savingStats = false;
    }
  }

  // ── Alert helpers ─────────────────────────────────────────────────

  /**
   * Parse the trigger (plan) order list (`planorder/list/orders`) into pending
   * STOP entries. Keeps only open-side entry orders (side 1/3) that are still
   * untriggered. Tolerates several response envelopes (array / `orders` /
   * `resultList` / `list`).
   */
  private extractPlanOrders(res: any): PendingOrderSummary[] {
    const list = this.asList(res?.data);
    const out: PendingOrderSummary[] = [];
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const side = Number(o.side);
      if (side !== 1 && side !== 3) continue; // open-side entry STOPs only

      const orderId = String(o.id ?? o.orderId ?? "");
      const symbol = String(o.symbol ?? "");
      const triggerPrice = toFiniteNumber(o.triggerPrice);
      const triggerType = Number(o.triggerType) === 2 ? 2 : 1;
      const vol = toFiniteNumber(o.vol);
      if (!orderId || !symbol || !Number.isFinite(triggerPrice) || !Number.isFinite(vol) || vol <= 0) {
        continue;
      }

      out.push({
        orderId,
        symbol,
        side: side as 1 | 3,
        kind: "STOP",
        triggerType,
        triggerPrice,
        takeProfitPrice: NaN,
        stopLossPrice: NaN,
        positionType: side === 1 ? 1 : 2,
        vol,
        leverage: toFiniteNumber(o.leverage) || 0,
        openType: Number(o.openType) === 2 ? 2 : 1,
      });
    }
    return out;
  }

  /**
   * Parse the Stop-Limit order list (`stoporder/list/orders`) into pending
   * TP/SL pairs. Each row carries BOTH the take-profit and stop-loss price for
   * a position. Tolerates several response envelopes.
   */
  private extractStopOrders(res: any): PendingOrderSummary[] {
    const list = this.asList(res?.data);
    const out: PendingOrderSummary[] = [];
    for (const o of list) {
      if (!o || typeof o !== "object") continue;

      const orderId = String(o.id ?? o.orderId ?? "");
      const symbol = String(o.symbol ?? "");
      const stopLossPrice = toFiniteNumber(o.stopLossPrice);
      const takeProfitPrice = toFiniteNumber(o.takeProfitPrice);
      const vol = toFiniteNumber(o.vol);
      const positionType = Number(o.positionType) === 2 ? 2 : 1;
      if (!orderId || !symbol || vol <= 0) continue;
      if (!Number.isFinite(stopLossPrice) && !Number.isFinite(takeProfitPrice)) continue;

      out.push({
        orderId,
        symbol,
        side: positionType === 1 ? 4 : 2, // close long / close short
        kind: "TP_SL",
        triggerType: 1,
        triggerPrice: NaN,
        takeProfitPrice,
        stopLossPrice,
        positionType,
        vol,
        leverage: 0, // TP/SL records do not carry leverage
        openType: Number(o.openType) === 2 ? 2 : 1,
      });
    }
    return out;
  }

  /** Normalize a `data` payload into an array regardless of envelope shape. */
  private asList(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.orders)) return raw.orders;
    if (Array.isArray(raw?.resultList)) return raw.resultList;
    if (Array.isArray(raw?.list)) return raw.list;
    return [];
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
