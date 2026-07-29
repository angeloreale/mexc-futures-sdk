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
}
