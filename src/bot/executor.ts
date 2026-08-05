import crypto from "crypto";
import { MexcFuturesSDK } from "../client";
import { SubmitOrderRequest, SubmitOrderResponse, SubmitPlanOrderRequest } from "../types/orders";
import { Position } from "../types/account";
import { BotConfig, ResolvedTrade, TradeRecord } from "./types";
import { Logger } from "../utils/logger";

/**
 * Executes a resolved trade by submitting orders to MEXC.
 */
export class TradeExecutor {
  private client: MexcFuturesSDK;
  private config: BotConfig;
  private logger: Logger;

  constructor(client: MexcFuturesSDK, config: BotConfig, logger: Logger) {
    this.client = client;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Execute a single resolved trade.
   * Routes to market or trigger order based on signal.orderType.
   * If multiple TP targets exist, splits volume equally across them.
   */
  async execute(trade: ResolvedTrade): Promise<TradeRecord[]> {
    // Dry-run / disabled checks
    if (this.config.dryRun) {
      const orderTypeLabel = trade.signal.orderType === "trigger" ? "LIMIT_ENTRY" : "MARKET";
      this.logger.info(`🧪 [DRY RUN] Would submit ${orderTypeLabel} order:`);
      this.logger.info(
        `   Symbol: ${trade.mexcSymbol}, Side: ${trade.side === 1 ? "LONG" : "SHORT"}`
      );
      this.logger.info(
        `   Volume: ${trade.volume}, Entry/Trigger: ${trade.entry}, SL: ${trade.stopLossPrice}`
      );
      this.logger.info(`   TP targets: ${trade.allTpTargets.join(", ")}`);
      this.logger.info(
        `   Leverage: ${trade.leverage}, OpenType: ${trade.openType === 1 ? "Isolated" : "Cross"}`
      );
      this.logger.info(
        `   Risk: ${trade.riskAmount.toFixed(2)} USDT (${(trade.riskPercent * 100).toFixed(1)}% of ${trade.equity.toFixed(2)})`
      );

      const record: TradeRecord = {
        resolved: trade,
        orderId: "DRY_RUN",
        success: true,
        executedAt: Date.now(),
        orderVolume: trade.volume,
        orderTp: trade.takeProfitPrice,
      };
      this.logTradeRecord(record);
      return [record];
    }

    if (!this.config.tradingEnabled) {
      this.logger.warn("⚠️ Trading is disabled — skipping execution");
      const record: TradeRecord = {
        resolved: trade,
        orderId: "DISABLED",
        success: false,
        error: "Trading disabled",
        executedAt: Date.now(),
        orderVolume: trade.volume,
        orderTp: trade.takeProfitPrice,
      };
      this.logTradeRecord(record);
      return [record];
    }

    // Route to the appropriate execution method
    if (trade.signal.orderType === "trigger") {
      return this.executeTrigger(trade);
    }
    return this.executeMarket(trade);
  }

  /**
   * Close an open position immediately (or partially) with a market order.
   *
   * @param symbol   MEXC contract symbol (e.g. "BTC_USDT")
   * @param position The open-position record, providing holdVol and positionId
   * @param currentPrice Current market price for the market close order
   * @param positionType 1=long, 2=short
   * @param openType 1=isolated, 2=cross
   * @param leverage Leverage used (optional, MEXC may require for isolated)
   * @param closePercent Percentage of the position to close (1–100, default 100 = full close)
   * @param volScale Volume decimal places for this contract (0 = integer), defaults to 8 as safety
   * @param volUnit Volume step unit for this contract (e.g. 0.01), defaults to 1e-8 as safety
   */
  async closePosition(
    symbol: string,
    position: Position,
    currentPrice: number,
    positionType: 1 | 2,
    openType: 1 | 2,
    leverage: number,
    closePercent: number = 100,
    volScale?: number,
    volUnit?: number
  ): Promise<{ success: boolean; orderId?: string; volume?: number; error?: string }> {
    // Calculate the volume to close, respecting the percentage and contract precision.
    const rawVol = position.holdVol * (closePercent / 100);

    // Round to contract precision.  When volScale/volUnit are known, use them;
    // otherwise fall back to a safe default (8 decimals) with a warning.
    let closeVol: number;
    if (volScale !== undefined && volUnit !== undefined && volUnit > 0) {
      const stepped = Math.floor(rawVol / volUnit) * volUnit;
      if (volScale > 0) {
        const factor = Math.pow(10, volScale);
        closeVol = Math.floor(stepped * factor) / factor;
      } else {
        closeVol = stepped;
      }
    } else {
      // Fallback: round to 8 decimals — may fail for contracts with coarse volume steps.
      closeVol = Math.floor(rawVol * 1e8) / 1e8;
      this.logger.warn(
        `⚠️ No volScale/volUnit provided for ${symbol} — rounding vol to 8dp (may fail for some contracts)`
      );
    }

    if (closeVol <= 0) {
      // If the rounded volume rounds to zero, try the minimum possible step.
      if (volUnit && volUnit > 0) {
        closeVol = volUnit;
      } else {
        return { success: false, error: `Computed close volume is zero (${closePercent}% of ${position.holdVol})` };
      }
    }

    if (this.config.dryRun) {
      this.logger.info(
        `🧪 [DRY RUN] Would close ${symbol} ${closePercent}% (vol=${closeVol}, price=${currentPrice})`
      );
      return { success: true, orderId: "DRY_RUN", volume: closeVol };
    }

    if (!this.config.tradingEnabled) {
      return { success: false, error: "Trading disabled" };
    }

    // side 2 = close long, side 4 = close short
    const side = positionType === 1 ? 2 : 4;

    const params: SubmitOrderRequest = {
      symbol,
      price: currentPrice || 0,
      vol: closeVol,
      side,
      type: 5, // market
      openType,
      leverage,
      reduceOnly: true,
      positionId: position.positionId,
    };

    try {
      this.logger.info(
        `🔚 Closing position: ${symbol} ${positionType === 1 ? "LONG" : "SHORT"} vol=${closeVol} side=${side}`
      );
      const response = await this.client.submitOrder(params);
      if (response.success) {
        const oid = String(response.data ?? "");
        this.logger.info(`✅ Close order placed: ${oid} for ${symbol}`);
        return { success: true, orderId: oid, volume: closeVol };
      }
      return {
        success: false,
        error: response.message || `Code ${response.code}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Close order failed for ${symbol}: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Execute a market order (immediate fill, no @/EP in signal).
   */
  private async executeMarket(trade: ResolvedTrade): Promise<TradeRecord[]> {
    return this.splitAndSubmit(trade, false);
  }

  /**
   * Execute a trigger (stop-entry) order (signal had @ or EP).
   * Places pending trigger orders that fire when price reaches entry.
   */
  private async executeTrigger(trade: ResolvedTrade): Promise<TradeRecord[]> {
    return this.splitAndSubmit(trade, true);
  }

  /**
   * Shared split-and-submit logic for both market and trigger orders.
   * Splits volume across multiple TP targets if needed.
   */
  private async splitAndSubmit(trade: ResolvedTrade, isTrigger: boolean): Promise<TradeRecord[]> {
    const records: TradeRecord[] = [];

    if (trade.allTpTargets.length <= 1) {
      const record = await this.submitSingleOrder(trade, trade.volume, trade.takeProfitPrice, isTrigger);
      records.push(record);
      this.logTradeRecord(record);
      return records;
    }

    // Multiple TP targets: split volume equally, respecting contract precision.
    const { minVol, volScale, volUnit } = trade;
    const maxSplits = Math.floor(trade.volume / minVol);
    if (maxSplits < 2) {
      this.logger.info(
        `📎 Volume ${trade.volume} too small to split across ${trade.allTpTargets.length} TPs (minVol=${minVol}) — using single TP=${trade.takeProfitPrice}`
      );
      const record = await this.submitSingleOrder(trade, trade.volume, trade.takeProfitPrice, isTrigger);
      records.push(record);
      this.logTradeRecord(record);
      return records;
    }

    const targetCount = Math.min(trade.allTpTargets.length, maxSplits);
    if (targetCount < trade.allTpTargets.length) {
      this.logger.info(
        `📎 Volume ${trade.volume} can only split across ${targetCount}/${trade.allTpTargets.length} TPs (minVol=${minVol})`
      );
    }

    const roundVol = (v: number): number => {
      const stepped = Math.floor(v / volUnit) * volUnit;
      if (volScale > 0) {
        const factor = Math.pow(10, volScale);
        return Math.floor(stepped * factor) / factor;
      }
      return stepped;
    };

    const rawPerTarget = trade.volume / targetCount;
    const volPerTarget = roundVol(rawPerTarget);
    const used = volPerTarget * targetCount;
    const remainder = roundVol(trade.volume - used);

    for (let i = 0; i < targetCount; i++) {
      const vol = i === 0 ? volPerTarget + remainder : volPerTarget;
      if (vol < minVol) continue;

      const tp = trade.allTpTargets[i];
      const record = await this.submitSingleOrder(trade, vol, tp, isTrigger);
      records.push(record);
      this.logTradeRecord(record);

      if (!record.success) {
        this.logger.error(
          `❌ Order ${i + 1}/${targetCount} failed — aborting remaining splits`
        );
        break;
      }
    }

    return records;
  }

  /**
   * Submit a single order.
   *
   * Market orders (isTrigger=false): immediate fill via /order/submit (type=5).
   *
   * Plan/stop orders (isTrigger=true): placed via /planorder/place/v2.
   * The triggerType is chosen so the order is ALWAYS pending — it only fires
   * when the market price actually CROSSES the entry price, regardless of
   * which side of the entry the market is currently on:
   *
   *   BUY:
   *     currentPrice < entry  → triggerType=1 (price >= EP, buy stop — wait for rise)
   *     currentPrice >= entry → triggerType=2 (price <= EP, buy limit — wait for drop)
   *   SELL:
   *     currentPrice > entry  → triggerType=2 (price <= EP, sell stop — wait for drop)
   *     currentPrice <= entry → triggerType=1 (price >= EP, sell limit — wait for rise)
   *
   * If currentPrice ≈ entry (within 0.01%), falls back to a market order
   * since either trigger direction would fire immediately.
   */
  private async submitSingleOrder(
    trade: ResolvedTrade,
    volume: number,
    takeProfitPrice: number,
    isTrigger: boolean
  ): Promise<TradeRecord> {
    const rawId = `${trade.signal.chatId || 0}_${trade.signal.messageId || 0}_${takeProfitPrice}_${volume}`;
    const hash = crypto.createHash("md5").update(rawId).digest("hex").substring(0, 16);
    const externalOid = `tg_${hash}`;

    if (isTrigger) {
      const isBuy = trade.side === 1;
      const entry = trade.entry;
      const cp = trade.currentPrice;

      // If current price is within 0.01% of entry, either trigger direction
      // fires immediately — fall back to market order.
      const tolerance = entry * 0.0001;
      if (Math.abs(cp - entry) <= tolerance) {
        this.logger.info(
          `📍 Price ${cp} ≈ entry ${entry} (within tolerance) — using market order instead of plan order`
        );
        return this.submitSingleOrder(trade, volume, takeProfitPrice, false);
      }

      // Determine triggerType so the order is always pending:
      //   triggerType=1 → fires when price RISES to >= triggerPrice
      //   triggerType=2 → fires when price FALLS to <= triggerPrice
      let triggerType: 1 | 2;
      let dirLabel: string;

      if (isBuy) {
        if (cp < entry) {
          triggerType = 1; // price is below → wait for rise (buy stop)
          dirLabel = "↑ buy stop";
        } else {
          triggerType = 2; // price is above → wait for drop (buy limit)
          dirLabel = "↓ buy limit";
        }
      } else {
        if (cp > entry) {
          triggerType = 2; // price is above → wait for drop (sell stop)
          dirLabel = "↓ sell stop";
        } else {
          triggerType = 1; // price is below → wait for rise (sell limit)
          dirLabel = "↑ sell limit";
        }
      }

      // Plan order (stop/conditional entry) via /planorder/place/v2.
      const planParams: SubmitPlanOrderRequest = {
        symbol: trade.mexcSymbol,
        triggerPrice: entry,
        triggerType,
        orderType: 5, // market execution on trigger
        executeCycle: trade.signal.executeCycle ?? 1, // V7 → 7d, default 24h
        trend: 1, // latest price
        vol: volume,
        leverage: trade.leverage,
        side: trade.side,
        openType: trade.openType,
        stopLossPrice: trade.stopLossPrice,
        takeProfitPrice: takeProfitPrice,
        externalOid,
      };

      this.logger.info(
        `🎯 Plan/Stop entry: ${trade.mexcSymbol} ${isBuy ? "LONG" : "SHORT"} ${dirLabel} trigger@${entry} (current=${cp}) vol=${volume} SL=${trade.stopLossPrice} TP=${takeProfitPrice}`
      );

      try {
        const response = await this.client.submitPlanOrder(planParams);
        return this.toTradeRecord(trade, response as SubmitOrderResponse, volume, takeProfitPrice);
      } catch (error) {
        return this.toErrorRecord(trade, error, volume, takeProfitPrice);
      }
    }

    // Market order — immediate fill
    const orderParams: SubmitOrderRequest = {
      symbol: trade.mexcSymbol,
      price: trade.entry,
      vol: volume,
      side: trade.side,
      type: 5, // market
      openType: trade.openType,
      leverage: trade.leverage,
      stopLossPrice: trade.stopLossPrice,
      takeProfitPrice: takeProfitPrice,
      externalOid,
    };

    this.logger.info(
      `🚀 Market order: ${trade.mexcSymbol} ${trade.side === 1 ? "LONG" : "SHORT"} price=${trade.entry} vol=${volume} SL=${trade.stopLossPrice} TP=${takeProfitPrice}`
    );

    try {
      const response: SubmitOrderResponse = await this.client.submitOrder(orderParams);
      return this.toTradeRecord(trade, response, volume, takeProfitPrice);
    } catch (error) {
      return this.toErrorRecord(trade, error, volume, takeProfitPrice);
    }
  }

  /** Convert a successful/failed API response to a TradeRecord. */
  private toTradeRecord(
    trade: ResolvedTrade,
    response: SubmitOrderResponse,
    volume: number,
    takeProfitPrice: number
  ): TradeRecord {
    if (response.success) {
      const orderId = String(response.data || "unknown");
      this.logger.info(`✅ Order placed: ${orderId}`);
      return {
        resolved: trade,
        orderId,
        success: true,
        executedAt: Date.now(),
        orderVolume: volume,
        orderTp: takeProfitPrice,
      };
    }
    const errorMsg = response.message || `Code ${response.code}`;
    this.logger.error(`❌ Order rejected: ${errorMsg}`);
    return {
      resolved: trade,
      orderId: "",
      success: false,
      error: errorMsg,
      executedAt: Date.now(),
      orderVolume: volume,
      orderTp: takeProfitPrice,
    };
  }

  /** Convert a thrown error to a TradeRecord. */
  private toErrorRecord(
    trade: ResolvedTrade,
    error: unknown,
    volume: number,
    takeProfitPrice: number
  ): TradeRecord {
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Order submission failed: ${errorMsg}`);
    return {
      resolved: trade,
      orderId: "",
      success: false,
      error: errorMsg,
      executedAt: Date.now(),
      orderVolume: volume,
      orderTp: takeProfitPrice,
    };
  }

  /** Persist a trade record to the trades log file. */
  private logTradeRecord(record: TradeRecord): void {
    const t = record.resolved;
    this.logger.logTrade({
      orderId: record.orderId,
      success: record.success,
      error: record.error,
      symbol: t.mexcSymbol,
      side: t.side === 1 ? "LONG" : "SHORT",
      volume: t.volume,
      entry: t.entry,
      sl: t.stopLossPrice,
      tp: t.takeProfitPrice,
      leverage: t.leverage,
      openType: t.openType === 1 ? "ISOLATED" : "CROSS",
      equity: t.equity,
      riskAmount: t.riskAmount,
      dryRun: this.config.dryRun,
      signalChatId: t.signal.chatId,
      signalMessageId: t.signal.messageId,
      signalRaw: t.signal.raw,
    });
  }
}
