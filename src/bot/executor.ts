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
   * If multiple TP targets exist, splits volume equally across them.
   */
  async execute(trade: ResolvedTrade): Promise<TradeRecord[]> {
    const records: TradeRecord[] = [];

    if (this.config.dryRun) {
      this.logger.info(`🧪 [DRY RUN] Would submit order:`);
      this.logger.info(
        `   Symbol: ${trade.mexcSymbol}, Side: ${trade.side === 1 ? "LONG" : "SHORT"}`
      );
      this.logger.info(
        `   Volume: ${trade.volume}, Entry: ${trade.entry}, SL: ${trade.stopLossPrice}`
      );
      this.logger.info(`   TP targets: ${trade.allTpTargets.join(", ")}`);
      this.logger.info(
        `   Leverage: ${trade.leverage}, OpenType: ${trade.openType === 1 ? "Isolated" : "Cross"}`
      );
      this.logger.info(
        `   Risk: ${trade.riskAmount.toFixed(2)} USDT (${(this.config.riskPercent * 100).toFixed(1)}% of ${trade.equity.toFixed(2)})`
      );

      records.push({
        resolved: trade,
        orderId: "DRY_RUN",
        success: true,
        executedAt: Date.now(),
      });
      this.logTradeRecord(records[records.length - 1]);
      return records;
    }

    if (!this.config.tradingEnabled) {
      this.logger.warn("⚠️ Trading is disabled — skipping execution");
      records.push({
        resolved: trade,
        orderId: "DISABLED",
        success: false,
        error: "Trading disabled",
        executedAt: Date.now(),
      });
      this.logTradeRecord(records[records.length - 1]);
      return records;
    }

    // If single TP or only one TP target, submit one order with full volume
    if (trade.allTpTargets.length <= 1) {
      const record = await this.submitSingleOrder(trade, trade.volume, trade.takeProfitPrice);
      records.push(record);
      this.logTradeRecord(record);
      return records;
    }

    // Multiple TP targets: split volume equally, respecting contract precision.
    // Only split across as many targets as can hold at least minVol each.
    const { minVol, volScale, volUnit } = trade;
    const maxSplits = Math.floor(trade.volume / minVol);
    if (maxSplits < 2) {
      // Not enough volume to split — submit as a single order with the first TP
      this.logger.info(
        `📎 Volume ${trade.volume} too small to split across ${trade.allTpTargets.length} TPs (minVol=${minVol}) — using single TP=${trade.takeProfitPrice}`
      );
      const record = await this.submitSingleOrder(trade, trade.volume, trade.takeProfitPrice);
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

    // Round helper using contract volScale
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

    // Give remainder to the first target
    const used = volPerTarget * targetCount;
    const remainder = roundVol(trade.volume - used);

    for (let i = 0; i < targetCount; i++) {
      const vol = i === 0 ? volPerTarget + remainder : volPerTarget;
      if (vol < minVol) continue;

      const tp = trade.allTpTargets[i];
      const record = await this.submitSingleOrder(trade, vol, tp);
      records.push(record);
      this.logTradeRecord(record);

      // If the first order fails, don't continue
      if (!record.success) {
        this.logger.error(
          `❌ Order ${i + 1}/${targetCount} failed — aborting remaining splits`
        );
        break;
      }
    }

    return records;
  }

  private async submitSingleOrder(
    trade: ResolvedTrade,
    volume: number,
    takeProfitPrice: number
  ): Promise<TradeRecord> {
    // Generate a unique external order ID for idempotency (≤ 32 chars per MEXC limit).
    // Use a short MD5 hash of the trade identity fields to stay deterministic and compact.
    const rawId = `${trade.signal.chatId || 0}_${trade.signal.messageId || 0}_${takeProfitPrice}_${volume}`;
    const hash = crypto.createHash("md5").update(rawId).digest("hex").substring(0, 16);
    const externalOid = `tg_${hash}`;

    const orderParams: SubmitOrderRequest = {
      symbol: trade.mexcSymbol,
      price: trade.entry,
      vol: volume,
      side: trade.side,
      type: 5, // market order
      openType: trade.openType,
      leverage: trade.leverage,
      stopLossPrice: trade.stopLossPrice,
      takeProfitPrice: takeProfitPrice,
      externalOid,
    };

    this.logger.info(
      `🚀 Submitting order: ${trade.mexcSymbol} ${trade.side === 1 ? "LONG" : "SHORT"} vol=${volume} entry=${trade.entry} SL=${trade.stopLossPrice} TP=${takeProfitPrice}`
    );

    try {
      const response: SubmitOrderResponse =
        await this.client.submitOrder(orderParams);

      if (response.success) {
        const orderId = String(response.data || "unknown");
        this.logger.info(`✅ Order placed: ${orderId}`);
        return {
          resolved: trade,
          orderId,
          success: true,
          executedAt: Date.now(),
        };
      } else {
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
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Order submission failed: ${errorMsg}`);
      return {
        resolved: trade,
        orderId: "",
        success: false,
        error: errorMsg,
        executedAt: Date.now(),
      };
    }
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
