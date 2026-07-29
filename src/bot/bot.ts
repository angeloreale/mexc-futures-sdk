import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import { MexcFuturesSDK } from "../client";
import { Logger } from "../utils/logger";
import { BotConfig, TradeSignal } from "./types";
import { parseSignal, normalizeSymbol } from "./parser";
import { ContractResolver } from "./resolver";
import { calculatePositionSize } from "./sizer";
import { TradeExecutor } from "./executor";
import { BotState } from "./state";

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

  constructor(config: BotConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel);

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

    // Register message handler
    this.telegram.on(message("text"), (ctx) => this.handleMessage(ctx));

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      this.logger.info(`\n🛑 Received ${signal} — shutting down...`);
      this.telegram.stop(signal);
      process.exit(0);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    // Launch bot (long-polling)
    await this.telegram.launch();
    this.logger.info("✅ Bot is running and listening for signals");
  }

  /**
   * Handle an incoming text message from Telegram.
   */
  private async handleMessage(ctx: Context & { message: { text: string } }): Promise<void> {
    const msg = ctx.message;
    if (!msg || !("text" in msg)) return;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const text = msg.text;

    // Check if from allowed channel
    const chatUsername = "username" in msg.chat ? (msg.chat as { username?: string }).username : undefined;
    if (!this.isAllowedChannel(chatId, chatUsername)) {
      return; // silently ignore
    }

    this.logger.debug(
      `📨 Message from ${chatId}#${messageId}: ${text.substring(0, 80)}...`
    );

    // Idempotency check
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ Message ${chatId}#${messageId} already processed`);
      return;
    }

    // Try to parse as signal
    const signal = parseSignal(text, messageId, chatId, msg.date);
    if (!signal) {
      this.logger.debug("📝 Not a trade signal — ignoring");
      return;
    }

    this.logger.info(
      `📊 Signal detected: ${signal.action} ${signal.rawSymbol}@${signal.entry} SL ${signal.sl} TP ${signal.tp.join(",") || "(default)"}`
    );

    // Mark as processed now to prevent duplicate processing on restart
    this.state.markProcessed(chatId, messageId);

    // Process the signal
    await this.processSignal(signal);
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

    // 3. Get account equity
    let equity: number;
    try {
      const asset = await this.mexcClient.getAccountAsset(this.config.baseCurrency);
      equity = asset.data?.equity || 0;
      if (equity <= 0) {
        this.logger.error("❌ Account equity is zero or negative — cannot size position");
        return;
      }
      this.logger.info(`💰 Account equity: ${equity} ${this.config.baseCurrency}`);
    } catch (error) {
      this.logger.error("❌ Failed to fetch account equity:", error);
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
    const resolvedTrade = calculatePositionSize(
      signal,
      contract,
      equity,
      this.config,
      this.logger
    );
    if (!resolvedTrade) {
      this.logger.warn("⚠️ Position sizing failed — skipping trade");
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
