import crypto from "crypto";
import { MexcFuturesSDK } from "../client";
import { SubmitOrderRequest, SubmitOrderResponse } from "../types/orders";
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
   * Submit a single order — market (type=5) or limit entry (type=1).
   * Limit orders replace the old /trigger/submit endpoint (which was removed
   * from the futures.mexc.com domain). A limit order at the entry price sits in
   * the order book until filled — functionally equivalent to a trigger entry.
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

    const orderType: 1 | 5 = isTrigger ? 1 : 5; // 1=limit, 5=market

    const orderParams: SubmitOrderRequest = {
      symbol: trade.mexcSymbol,
      price: trade.entry,
      vol: volume,
      side: trade.side,
      type: orderType,
      openType: trade.openType,
      leverage: trade.leverage,
      stopLossPrice: trade.stopLossPrice,
      takeProfitPrice: takeProfitPrice,
      externalOid,
    };

    const label = isTrigger ? "Limit entry" : "Market";
    this.logger.info(
      `🚀 ${label} order: ${trade.mexcSymbol} ${trade.side === 1 ? "LONG" : "SHORT"} price=${trade.entry} vol=${volume} SL=${trade.stopLossPrice} TP=${takeProfitPrice}`
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
