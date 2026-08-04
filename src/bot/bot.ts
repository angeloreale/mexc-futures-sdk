import { Telegraf, Context } from "telegraf";
import { message, channelPost } from "telegraf/filters";
import { MexcFuturesSDK } from "../client";
import { Logger } from "../utils/logger";
import { BotConfig, TradeSignal } from "./types";
import { parseSignals, normalizeSymbol } from "./parser";
import { ContractResolver } from "./resolver";
import { calculatePositionSize } from "./sizer";
import { TradeExecutor } from "./executor";
import { BotState } from "./state";
import {
  PositionClosureMonitor,
  AccountSnapshot,
  ClosedPositionInfo,
} from "./pnlMonitor";
import { formatPositionClosedMessage } from "./pnlMessage";
import {
  PositionSummaryMonitor,
  PositionSummary,
} from "./summaryMonitor";
import { formatPositionSummaryMessage } from "./summaryMessage";

/**
 * Main Telegram Signal Bot.
 * Listens for trading signals on configured channels, parses them,
 * validates against MEXC contracts, sizes positions, and executes trades.
 */
export class SignalBot {
  private config: BotConfig;
  private logger: Logger;
  private telegram: Telegraf;
  private mexcClient: MexcFuturesSDK;
  private resolver: ContractResolver;
  private executor: TradeExecutor;
  private state: BotState;
  /** Polls MEXC for closed positions and sends PNL notifications (null when disabled). */
  private pnlMonitor: PositionClosureMonitor | null = null;
  /** Periodically samples open positions and sends a summary (null when disabled). */
  private summaryMonitor: PositionSummaryMonitor | null = null;
  /** Cache account equity for 10s to avoid rate limits on rapid signals. */
  private equityCache: { equity: number; ts: number } | null = null;
  private readonly EQUITY_CACHE_TTL_MS = 10_000;

  constructor(config: BotConfig) {
    this.config = config;
    this.logger = new Logger({
      level: config.logLevel,
      logDir: config.logDir,
      retentionDays: config.logRetentionDays,
    });

    // Initialize MEXC client (prefers API key auth over browser token)
    this.mexcClient = new MexcFuturesSDK({
      apiKey: config.mexcApiKey || undefined,
      secretKey: config.mexcSecretKey || undefined,
      authToken: config.mexcAuthToken || undefined,
      logLevel: config.logLevel,
    });

    // Initialize subsystems
    this.resolver = new ContractResolver(this.mexcClient, this.logger);
    this.executor = new TradeExecutor(this.mexcClient, config, this.logger);
    this.state = new BotState(config.stateFilePath, this.logger);

    // Position-close PNL notifications (only when a channel is configured)
    if (config.pnlNotificationChannel) {
      this.pnlMonitor = new PositionClosureMonitor({
        client: this.mexcClient,
        logger: this.logger,
        baseCurrency: config.baseCurrency,
        intervalSeconds: config.positionMonitorIntervalSeconds,
        onClose: (info, account) =>
          this.sendPositionClosedNotification(info, account),
      });
    }

    // Periodic position summaries (only when a channel is configured)
    if (config.summaryNotificationChannel) {
      this.summaryMonitor = new PositionSummaryMonitor({
        client: this.mexcClient,
        logger: this.logger,
        baseCurrency: config.baseCurrency,
        sampleIntervalSeconds: config.positionMonitorIntervalSeconds,
        windowHours: config.summaryWindowHours,
        intervalHours: config.summaryIntervalHours,
        onSummary: (summary) => this.sendPositionSummary(summary),
      });
    }

    // Initialize Telegram bot
    this.telegram = new Telegraf(config.telegramBotToken);
  }

  /**
   * Start the bot — connect to Telegram and begin listening.
   */
  async start(): Promise<void> {
    this.logger.info("🤖 Starting Signal Bot...");
    this.logger.info(
      `   Mode: ${this.config.dryRun ? "DRY RUN" : "LIVE"}`
    );
    this.logger.info(
      `   Trading: ${this.config.tradingEnabled ? "ENABLED" : "DISABLED"}`
    );
    this.logger.info(
      `   Risk: ${(this.config.riskPercent * 100).toFixed(1)}% per trade`
    );
    this.logger.info(
      `   Leverage: ${this.config.leverage}x ${this.config.openType === 1 ? "Isolated" : "Cross"}`
    );
    this.logger.info(
      `   Channels: ${this.config.allowedChannels.join(", ")}`
    );

    // Pre-warm contract cache
    try {
      await this.resolver.refreshIfNeeded();
    } catch (error) {
      this.logger.error("❌ Failed to load MEXC contracts — continuing anyway");
    }

    // Test MEXC connection
    try {
      const connected = await this.mexcClient.testConnection();
      this.logger.info(
        `   MEXC connection: ${connected ? "✅ OK" : "❌ FAILED"}`
      );
    } catch {
      this.logger.warn("⚠️ MEXC connection test failed");
    }

    // Register handlers for both group/DM messages and channel posts
    this.telegram.on(message("text"), (ctx) => this.handleTelegramMessage(ctx, "message"));
    this.telegram.on(channelPost("text"), (ctx) => this.handleTelegramMessage(ctx, "channel_post"));

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      this.logger.info(`\n🛑 Received ${signal} — shutting down...`);
      this.pnlMonitor?.stop();
      this.summaryMonitor?.stop();
      this.telegram.stop(signal);
      await this.logger.close();
      process.exit(0);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    // Launch bot (long-polling)
    await this.telegram.launch();
    this.logger.info("✅ Bot is running and listening for signals");

    // Start position-close PNL notifications (after Telegram is live so sends work)
    if (this.pnlMonitor) {
      this.pnlMonitor.start();
      this.logger.info(
        `📨 PNL notifications → ${this.config.pnlNotificationChannel}`
      );
    }

    // Start periodic position summaries
    if (this.summaryMonitor) {
      this.summaryMonitor.start();
      this.logger.info(
        `📊 Position summary → ${this.config.summaryNotificationChannel} ` +
          `(every ${this.config.summaryIntervalHours}h, window ${this.config.summaryWindowHours}h)`
      );
    }
  }

  /**
   * Send the position-closed PNL notification to the configured channel.
   */
  private async sendPositionClosedNotification(
    info: ClosedPositionInfo,
    account: AccountSnapshot
  ): Promise<void> {
    const text = formatPositionClosedMessage(info, account);
    try {
      await this.telegram.telegram.sendMessage(
        this.config.pnlNotificationChannel,
        text,
        { parse_mode: "HTML" }
      );
      this.logger.info(
        `📨 PNL notification sent to ${this.config.pnlNotificationChannel}`
      );
    } catch (error) {
      this.logger.error(
        "❌ Failed to send PNL notification:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send the periodic position summary to the configured channel.
   */
  private async sendPositionSummary(summary: PositionSummary): Promise<void> {
    const text = formatPositionSummaryMessage(summary);
    try {
      await this.telegram.telegram.sendMessage(
        this.config.summaryNotificationChannel,
        text,
        { parse_mode: "HTML" }
      );
      this.logger.info(
        `📊 Position summary sent to ${this.config.summaryNotificationChannel}`
      );
    } catch (error) {
      this.logger.error(
        "❌ Failed to send position summary:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Handle an incoming text message from Telegram (group/DM or channel post).
   */
  private async handleTelegramMessage(
    ctx: Context,
    source: "message" | "channel_post"
  ): Promise<void> {
    // Extract message data from the correct context property
    const msg: any = source === "channel_post"
      ? (ctx as any).channelPost
      : (ctx as any).message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const text: string = msg.text;

    // Check if from allowed channel
    const chatUsername = msg.chat?.username;
    if (!this.isAllowedChannel(chatId, chatUsername)) {
      return; // silently ignore
    }

    this.logger.info(
      `📨 ${source === "channel_post" ? "Channel" : "Message"} from ${chatId}#${messageId}: ${text.substring(0, 80)}`
    );

    // Idempotency check
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ Message ${chatId}#${messageId} already processed`);
      return;
    }

    // Try to parse as one or more trade signals (multi-line support)
    const signals = parseSignals(text, messageId, chatId, msg.date);
    if (signals.length === 0) {
      this.logger.debug("📝 Not a trade signal — ignoring");
      return;
    }

    this.logger.info(
      `📊 ${signals.length} signal(s) detected in message ${chatId}#${messageId}`
    );

    for (const signal of signals) {
      this.logger.info(
        `   ${signal.action} ${signal.rawSymbol}${signal.orderType === "trigger" ? `@${signal.entry}` : ""} SL ${signal.sl} TP ${signal.tp.join(",") || "(default)"}${signal.riskPercentOverride !== undefined ? ` R${signal.riskPercentOverride}%` : ""} (${signal.orderType === "trigger" ? "🔔 limit entry" : "💹 market order"})`
      );
      // Persist parsed signal to file log
      this.logger.logSignal(signal);
    }

    // Mark as processed now to prevent duplicate processing on restart
    this.state.markProcessed(chatId, messageId);

    // Process each signal sequentially
    for (const signal of signals) {
      await this.processSignal(signal);
    }
  }

  /**
   * Fetch account equity with a 10-second cache and retry on rate limits.
   */
  private async fetchEquity(): Promise<number> {
    const now = Date.now();
    if (this.equityCache && now - this.equityCache.ts < this.EQUITY_CACHE_TTL_MS) {
      this.logger.debug(`📦 Using cached equity: ${this.equityCache.equity}`);
      return this.equityCache.equity;
    }

    const equity = await this.fetchEquityWithRetry(5);
    this.equityCache = { equity, ts: now };
    return equity;
  }

  /**
   * Fetch equity from MEXC with retry on 513 rate-limit errors.
   */
  private async fetchEquityWithRetry(maxRetries: number): Promise<number> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const asset = await this.mexcClient.getAccountAsset(
          this.config.baseCurrency
        );

        // Check for API-level error
        if (!asset.success) {
          if (asset.code === 513 && attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            this.logger.warn(
              `⏳ Rate limited (513) fetching equity — retry ${attempt}/${maxRetries} in ${delay}ms`
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`MEXC API error: code ${asset.code}`);
        }

        const inner = asset.data ?? asset;
        const equity: number = (inner as any).equity ?? 0;

        if (equity <= 0) {
          throw new Error(
            `Equity returned as ${equity} ${this.config.baseCurrency}`
          );
        }

        return equity;
      } catch (error) {
        // If it's an HTTP/network error and we can retry
        if (attempt < maxRetries) {
          const isRateLimit =
            error instanceof Error &&
            (error.message.includes("513") ||
             error.message.includes("rate limit") ||
             error.message.includes("Invalid request"));

          if (isRateLimit) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            this.logger.warn(
              `⏳ Rate limited fetching equity — retry ${attempt}/${maxRetries} in ${delay}ms`
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }
        throw error; // rethrow if out of retries or not a rate-limit error
      }
    }

    throw new Error("Failed to fetch equity after retries");
  }

  /**
   * Full pipeline: normalize → resolve → size → execute.
   */
  private async processSignal(signal: TradeSignal): Promise<void> {
    // 1. Normalize symbol
    const mexcSymbol = normalizeSymbol(signal.rawSymbol);
    if (!mexcSymbol) {
      this.logger.warn(
        `⚠️ Cannot normalize symbol "${signal.rawSymbol}" — unsupported instrument`
      );
      return;
    }
    this.logger.info(`🔄 Normalized: ${signal.rawSymbol} → ${mexcSymbol}`);

    // 2. Resolve against MEXC contracts
    const contract = await this.resolver.resolve(mexcSymbol);
    if (!contract) {
      this.logger.warn(`⚠️ Symbol ${mexcSymbol} not tradable on MEXC — skipping`);
      return;
    }
    this.logger.info(
      `✅ Contract found: ${contract.symbol} (size=${contract.contractSize}, minVol=${contract.minVol})`
    );

    // 2.5. Resolve entry price via ticker. For market orders this provides the entry;
    //      for trigger orders it determines the correct trigger direction so the
    //      plan order stays pending until price actually crosses the entry level.
    let currentPrice: number;
    try {
      const ticker = await this.mexcClient.getTicker(mexcSymbol);
      currentPrice = ticker?.data?.lastPrice;
      if (!currentPrice || currentPrice <= 0) {
        this.logger.error(`❌ Could not resolve market price for ${mexcSymbol}`);
        return;
      }

      if (signal.orderType === "market") {
        signal.entry = currentPrice;
        this.logger.info(`💹 Market entry resolved: ${mexcSymbol} @ ${currentPrice}`);
      } else {
        const dir = signal.action === "BUY"
          ? (currentPrice >= signal.entry ? "above" : "below")
          : (currentPrice <= signal.entry ? "below" : "above");
        this.logger.info(
          `🔔 Trigger entry: ${mexcSymbol} @ ${signal.entry} | current price ${currentPrice} (${dir} trigger) → will wait for price to cross`
        );
      }
    } catch (error) {
      this.logger.error(`❌ Failed to fetch ticker for ${mexcSymbol}:`, error);
      return;
    }

    // 3. Get account equity (cached for 10s to avoid rate limits)
    let equity: number;
    try {
      equity = await this.fetchEquity();
      if (equity <= 0) {
        this.logger.error(
          `❌ Account equity is ${equity} ${this.config.baseCurrency} — cannot size position`
        );
        return;
      }
      this.logger.info(`💰 Account equity: ${equity} ${this.config.baseCurrency}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Failed to fetch account equity: ${errorMsg}`);
      return;
    }

    // 4. Check concurrent positions
    try {
      const positions = await this.mexcClient.getOpenPositions();
      const openCount = positions.data?.length || 0;
      if (openCount >= this.config.maxConcurrentTrades) {
        this.logger.warn(
          `⚠️ Max concurrent trades reached (${openCount}/${this.config.maxConcurrentTrades}) — skipping`
        );
        return;
      }
    } catch (error) {
      this.logger.warn("⚠️ Could not check open positions — proceeding anyway");
    }

    // 5. Calculate position size
    // Compute effective risk % BEFORE the sizer so we can log it even on failure
    const effectiveRiskPct = signal.riskPercentOverride !== undefined
      ? signal.riskPercentOverride
      : this.config.riskPercent * 100;

    const resolvedTrade = calculatePositionSize(
      signal,
      contract,
      equity,
      currentPrice,
      this.config,
      this.logger
    );
    if (!resolvedTrade) {
      // The sizer already logged a specific reason (stop distance, minVol, notional, etc.)
      this.logger.warn(
        `⚠️ Position sizing failed for ${mexcSymbol} (equity=${equity.toFixed(2)}, risk=${effectiveRiskPct.toFixed(2)}%) — skipping trade`
      );
      return;
    }

    this.logger.info(
      `📐 Sized: ${resolvedTrade.volume} contracts, ${resolvedTrade.side === 1 ? "LONG" : "SHORT"}, leverage ${resolvedTrade.leverage}x`
    );

    // 6. Execute
    const records = await this.executor.execute(resolvedTrade);
    for (const record of records) {
      if (record.success) {
        this.logger.info(
          `✅ Trade executed: ${record.orderId} for ${resolvedTrade.mexcSymbol}`
        );
      } else {
        this.logger.error(
          `❌ Trade failed: ${record.error} for ${resolvedTrade.mexcSymbol}`
        );
      }
    }
  }

  /**
   * Check if a chat is in the allowed channels list.
   */
  private isAllowedChannel(chatId: string, username?: string): boolean {
    // Check by numeric ID
    if (this.config.allowedChannels.includes(chatId)) {
      return true;
    }

    // Check by username (e.g. "@channelname")
    if (
      username &&
      this.config.allowedChannels.some(
        (ch) =>
          ch === `@${username}` ||
          ch.toLowerCase() === username.toLowerCase()
      )
    ) {
      return true;
    }

    return false;
  }
}
