import { MexcFuturesSDK } from "../client";
import { Position } from "../types/account";
import { Logger } from "../utils/logger";

/**
 * Data about a position that just closed, enough to report realized PNL.
 */
export interface ClosedPositionInfo {
  /** MEXC position ID */
  positionId: string;
  /** Contract symbol (e.g. "BTC_USDT") */
  symbol: string;
  /** Position type: 1 = long, 2 = short */
  positionType: 1 | 2;
  /** Open type: 1 = isolated, 2 = cross */
  openType: 1 | 2;
  /** Leverage used */
  leverage: number;
  /** Average open price */
  openAvgPrice: number;
  /** Average close price */
  closeAvgPrice: number;
  /** Realized PNL in quote currency (USDT), net of fees */
  realisedPnl: number;
  /** Realized PNL as a percentage of the position's initial margin */
  pnlPercent: number;
  /** Original initial margin used for the position */
  margin: number;
  /** Position create timestamp (ms) */
  createTime: number;
  /** Position close timestamp (ms) */
  closeTime: number;
}

/**
 * Account balance snapshot taken AFTER the position closed.
 */
export interface AccountSnapshot {
  /** Available (free) balance in quote currency */
  availableBalance: number;
  /** Total equity in quote currency */
  equity: number;
  /** Quote currency (e.g. "USDT") */
  currency: string;
}

/** Callback fired when a position closes and its PNL data is ready. */
export type OnPositionClosed = (
  info: ClosedPositionInfo,
  account: AccountSnapshot
) => void;

export interface PositionClosureMonitorOptions {
  client: MexcFuturesSDK;
  logger: Logger;
  /** Quote currency used for equity/balance (e.g. "USDT") */
  baseCurrency: string;
  /** Polling interval in seconds (clamped to >= 5) */
  intervalSeconds: number;
  /** Called once per detected position closure */
  onClose: OnPositionClosed;
}

/**
 * Polls MEXC open positions and fires a callback whenever a previously
 * tracked position is fully closed.
 *
 * Detection strategy:
 *  - The first successful poll SEEDS the known-position set, so positions
 *    that were already open before the bot started (or that closed while it
 *    was offline) are NOT reported as "just closed".
 *  - On each subsequent poll, any tracked position that is no longer in the
 *    open-positions response (or that has fully closed) is considered closed.
 *  - The authoritative realized PNL is then fetched from position history
 *    (with retries, since history can lag open_positions slightly).
 *  - A fresh account snapshot is fetched so the notification shows the
 *    balance and equity AFTER the position was closed.
 */
export class PositionClosureMonitor {
  private client: MexcFuturesSDK;
  private logger: Logger;
  private baseCurrency: string;
  private intervalMs: number;
  private onClose: OnPositionClosed;
  private timer: NodeJS.Timeout | null = null;
  private known = new Map<string, Position>();
  private seeded = false;
  private polling = false;

  constructor(opts: PositionClosureMonitorOptions) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.baseCurrency = opts.baseCurrency;
    this.intervalMs = Math.max(opts.intervalSeconds, 5) * 1000;
    this.onClose = opts.onClose;
  }

  /**
   * Start polling. The timer is unref'd so it never keeps the process alive
   * on its own (the Telegram long-polling loop is what holds it open).
   */
  start(): void {
    if (this.timer) return;
    this.logger.info(
      `📡 Position closure monitor started (poll every ${this.intervalMs / 1000}s)`
    );
    // Poll immediately to seed, then on an interval.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Stop polling and release the interval. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one poll cycle. Public so tests can drive it directly.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await this.client.getOpenPositions();
      const positions: Position[] = Array.isArray(res.data) ? res.data : [];

      // Only genuinely-open positions are tracked. Anything already fully
      // closed (state 3 or zero remaining volume) is a closure candidate
      // rather than a live position.
      const active = positions.filter((p) => p.state !== 3 && p.holdVol > 0);
      const current = new Map(active.map((p) => [String(p.positionId), p]));

      if (!this.seeded) {
        this.known = current;
        this.seeded = true;
        this.logger.debug(
          `📡 Seeded position monitor with ${this.known.size} open position(s)`
        );
        return;
      }

      // Positions we tracked that are no longer open = closed.
      const closed: Position[] = [];
      for (const [id, lastKnown] of this.known) {
        if (!current.has(id)) {
          closed.push(lastKnown);
        }
      }

      this.known = current;

      for (const lastKnown of closed) {
        await this.handleClosed(String(lastKnown.positionId), lastKnown);
      }
    } catch (error) {
      this.logger.warn(
        "⚠️ Position monitor poll failed:",
        error instanceof Error ? error.message : error
      );
    } finally {
      this.polling = false;
    }
  }

  /**
   * Resolve the authoritative closed-position record (history may lag),
   * fetch a fresh account snapshot, then fire the onClose callback.
   */
  private async handleClosed(positionId: string, lastKnown: Position): Promise<void> {
    const history = await this.fetchClosedPosition(
      lastKnown.symbol,
      lastKnown.positionType,
      positionId
    );

    // Prefer the history record; fall back to the last known snapshot so a
    // missed history read still produces a notification.
    const src: Position = history ?? lastKnown;

    const margin = src.oim || src.im || 0;
    const realisedPnl = Number.isFinite(src.realised) ? src.realised : 0;

    const info: ClosedPositionInfo = {
      positionId,
      symbol: src.symbol,
      positionType: src.positionType,
      openType: src.openType,
      leverage: src.leverage,
      openAvgPrice: src.openAvgPrice,
      closeAvgPrice: src.closeAvgPrice,
      realisedPnl,
      pnlPercent: margin > 0 ? (realisedPnl / margin) * 100 : 0,
      margin,
      createTime: src.createTime,
      closeTime: src.updateTime || Date.now(),
    };

    this.logger.info(
      `🔔 Position closed: ${info.symbol} ${info.positionType === 1 ? "LONG" : "SHORT"} ` +
        `PNL ${info.realisedPnl.toFixed(2)} ${this.baseCurrency} (${info.pnlPercent.toFixed(2)}%)`
    );

    // Fresh snapshot so the notification reflects the post-close balance.
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
        "❌ Failed to fetch account snapshot for PNL notification:",
        error instanceof Error ? error.message : error
      );
      account = {
        availableBalance: NaN,
        equity: NaN,
        currency: this.baseCurrency,
      };
    }

    this.onClose(info, account);
  }

  /**
   * Fetch the closed position from history, retrying briefly since the
   * history endpoint can lag behind open_positions after a close.
   */
  private async fetchClosedPosition(
    symbol: string,
    positionType: 1 | 2,
    positionId: string
  ): Promise<Position | null> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.client.getPositionHistory({
          symbol,
          type: positionType,
          page_num: 1,
          page_size: 100,
        });
        const list: Position[] = Array.isArray(res.data) ? res.data : [];
        const found = list.find((p) => String(p.positionId) === positionId);
        if (found) return found;
      } catch (error) {
        this.logger.warn(
          `⚠️ Position history fetch failed (attempt ${attempt}/${maxAttempts}):`,
          error instanceof Error ? error.message : error
        );
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    return null;
  }
}
