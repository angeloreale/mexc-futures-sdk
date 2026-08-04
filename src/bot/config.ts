import { BotConfig } from "./types";

/**
 * Load and validate bot configuration from environment variables.
 * All secrets come from env — never from source files.
 */
export function loadConfig(): BotConfig {
  const env = process.env;

  // Support both MEXC_KEY + MEXC_SECRET_KEY (API key auth) and
  // MEXC_AUTH_TOKEN (browser WEB token auth). API keys take priority.
  const mexcApiKey = env.MEXC_KEY || "";
  const mexcSecretKey = env.MEXC_SECRET_KEY || "";
  const mexcAuthToken = env.MEXC_AUTH_TOKEN || "";

  if (!mexcApiKey && !mexcAuthToken) {
    throw new Error(
      "Either MEXC_KEY + MEXC_SECRET_KEY (API keys) or MEXC_AUTH_TOKEN (browser token) must be set"
    );
  }

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");

  const allowedChannels = (env.ALLOWED_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowedChannels.length === 0) {
    throw new Error(
      "ALLOWED_CHANNELS must be set to a comma-separated list of Telegram channel/chat IDs"
    );
  }

  const leverage = parseFloat(env.DEFAULT_LEVERAGE || "10");
  const openType = env.OPEN_TYPE === "2" ? 2 : 1; // default isolated

  const riskPercent = parseFloat(env.RISK_PERCENT || "0.01"); // default 1%
  const defaultTpRatio = parseFloat(env.DEFAULT_TP_RATIO || "1.5"); // 1.5R
  const maxConcurrentTrades = parseInt(env.MAX_CONCURRENT_TRADES || "5", 10);
  const maxNotionalPerTrade = parseFloat(
    env.MAX_NOTIONAL_PER_TRADE || "10000"
  );

  const dryRun = env.DRY_RUN === "true" || env.DRY_RUN === "1";
  const tradingEnabled =
    env.TRADING_ENABLED !== "false" && env.TRADING_ENABLED !== "0";

  const logLevel = (
    (env.LOG_LEVEL || "INFO").toUpperCase() as BotConfig["logLevel"]
  );

  const baseCurrency = env.BASE_CURRENCY || "USDT";
  const stateFilePath = env.STATE_FILE_PATH || "./bot-state.json";
  const logDir = env.LOG_DIR || "./logs";
  const logRetentionDays = parseInt(env.LOG_RETENTION_DAYS || "90", 10);

  // JSON file persisting per-position min/max PNL stats across restarts.
  // Defaults to a sibling of the state file: e.g. bot-summary-stats.json.
  const summaryStatsFilePath =
    (env.SUMMARY_STATS_FILE_PATH || "").trim() ||
    stateFilePath.replace(/\.json$/i, "") + "-summary-stats.json";

  // Position-close PNL notifications (optional — empty disables the feature)
  const pnlNotificationChannel = (env.PNL_NOTIFICATION_CHANNEL || "").trim();
  const positionMonitorIntervalSeconds = parseInt(
    env.POSITION_MONITOR_INTERVAL_SECONDS || "30",
    10
  );

  // Periodic position summaries (optional — falls back to the PNL channel)
  const summaryNotificationChannel = (
    (env.SUMMARY_NOTIFICATION_CHANNEL || "").trim() || pnlNotificationChannel
  ).trim();
  const summaryIntervalHours = parseFloat(env.SUMMARY_INTERVAL_HOURS || "8");
  const summaryWindowHours = parseFloat(env.SUMMARY_WINDOW_HOURS || "4");

  // Token-bucket API rate limiting. capacity = max requests fired in an
  // immediate burst (ASAP); intervalMs = spacing between requests after the
  // burst is spent (sustained ≈ 1000/intervalMs req/s). Prevents MEXC code 513
  // when one signal submits several orders + TPs back-to-back.
  const orderRateCapacity = parseInt(env.ORDER_RATE_CAPACITY || "3", 10);
  const orderRateIntervalMs = parseInt(env.ORDER_RATE_INTERVAL_MS || "200", 10);

  const config: BotConfig = {
    mexcApiKey,
    mexcSecretKey,
    mexcAuthToken,
    telegramBotToken,
    allowedChannels,
    leverage,
    openType: openType as 1 | 2,
    riskPercent,
    defaultTpRatio,
    maxConcurrentTrades,
    maxNotionalPerTrade,
    dryRun,
    tradingEnabled,
    logLevel,
    baseCurrency,
    stateFilePath,
    logDir,
    logRetentionDays,
    pnlNotificationChannel,
    positionMonitorIntervalSeconds,
    summaryNotificationChannel,
    summaryIntervalHours,
    summaryWindowHours,
    orderRateCapacity,
    orderRateIntervalMs,
  };

  validate(config);
  return config;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function validate(config: BotConfig): void {
  if (config.riskPercent <= 0 || config.riskPercent > 0.1) {
    throw new Error(
      `RISK_PERCENT must be between 0 and 0.1 (10%), got ${config.riskPercent}`
    );
  }
  if (config.leverage < 1 || config.leverage > 200) {
    throw new Error(
      `DEFAULT_LEVERAGE must be between 1 and 200, got ${config.leverage}`
    );
  }
  if (config.defaultTpRatio <= 0) {
    throw new Error(
      `DEFAULT_TP_RATIO must be > 0, got ${config.defaultTpRatio}`
    );
  }
  if (config.maxConcurrentTrades < 1) {
    throw new Error(
      `MAX_CONCURRENT_TRADES must be >= 1, got ${config.maxConcurrentTrades}`
    );
  }
  if (config.maxNotionalPerTrade <= 0) {
    throw new Error(
      `MAX_NOTIONAL_PER_TRADE must be > 0, got ${config.maxNotionalPerTrade}`
    );
  }
  if (config.logRetentionDays < 1) {
    throw new Error(
      `LOG_RETENTION_DAYS must be >= 1, got ${config.logRetentionDays}`
    );
  }
  if (config.positionMonitorIntervalSeconds < 5) {
    throw new Error(
      `POSITION_MONITOR_INTERVAL_SECONDS must be >= 5, got ${config.positionMonitorIntervalSeconds}`
    );
  }
  if (config.summaryIntervalHours < 1) {
    throw new Error(
      `SUMMARY_INTERVAL_HOURS must be >= 1, got ${config.summaryIntervalHours}`
    );
  }
  if (config.summaryWindowHours < 1) {
    throw new Error(
      `SUMMARY_WINDOW_HOURS must be >= 1, got ${config.summaryWindowHours}`
    );
  }
  if (config.orderRateCapacity < 1) {
    throw new Error(
      `ORDER_RATE_CAPACITY must be >= 1, got ${config.orderRateCapacity}`
    );
  }
  if (config.orderRateIntervalMs < 10) {
    throw new Error(
      `ORDER_RATE_INTERVAL_MS must be >= 10, got ${config.orderRateIntervalMs}`
    );
  }
}
