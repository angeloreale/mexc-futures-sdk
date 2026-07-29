/**
 * Trade signal parsed from a Telegram message.
 */
export interface TradeSignal {
  /** Original raw message text */
  raw: string;
  /** BUY or SELL */
  action: "BUY" | "SELL";
  /** Symbol as it appeared in the message (e.g. "TAOUSDT") */
  rawSymbol: string;
  /** Entry price from the signal */
  entry: number;
  /** Stop-loss price */
  sl: number;
  /** Take-profit price(s); at least one is always present after normalization */
  tp: number[];
  /** Telegram message ID for idempotency */
  messageId?: number;
  /** Telegram channel/chat ID */
  chatId?: number | string;
  /** Timestamp of the message */
  timestamp?: number;
}

/**
 * A fully resolved trade ready for submission.
 */
export interface ResolvedTrade {
  signal: TradeSignal;
  /** MEXC contract symbol (e.g. "TAO_USDT") */
  mexcSymbol: string;
  /** Computed order volume (contracts) */
  volume: number;
  /** Order side: 1=open long, 3=open short */
  side: 1 | 3;
  /** Leverage to use */
  leverage: number;
  /** Open type: 1=isolated, 2=cross */
  openType: 1 | 2;
  /** Entry price (rounded to contract priceScale) */
  entry: number;
  /** Stop-loss price (rounded to contract priceScale) */
  stopLossPrice: number;
  /** Take-profit price (first/only target for the main order) */
  takeProfitPrice: number;
  /** All TP targets if multiple */
  allTpTargets: number[];
  /** Account equity at time of sizing */
  equity: number;
  /** Risk amount (equity * riskPercent) */
  riskAmount: number;
  /** Minimum order volume (contracts) */
  minVol: number;
  /** Volume scale (decimal places) */
  volScale: number;
  /** Volume step unit */
  volUnit: number;
}

/**
 * Record of an executed trade for traceability.
 */
export interface TradeRecord {
  resolved: ResolvedTrade;
  orderId: string;
  success: boolean;
  error?: string;
  executedAt: number;
}

/**
 * Bot configuration loaded from environment.
 */
export interface BotConfig {
  /** MEXC API key (e.g. "mx0...") */
  mexcApiKey: string;
  /** MEXC API secret key */
  mexcSecretKey: string;
  /** MEXC WEB auth token (browser session token, legacy) */
  mexcAuthToken: string;
  /** Telegram Bot API token */
  telegramBotToken: string;
  /** Allowed Telegram channel/chat IDs (numeric or @username strings) */
  allowedChannels: string[];

  /** Default leverage */
  leverage: number;
  /** Open type: 1=isolated, 2=cross */
  openType: 1 | 2;

  /** Risk percentage per trade (0.01 = 1%) */
  riskPercent: number;
  /** Default TP:SL ratio when no TP is given */
  defaultTpRatio: number;
  /** Max concurrent open positions */
  maxConcurrentTrades: number;
  /** Max notional per trade in USDT */
  maxNotionalPerTrade: number;

  /** Dry-run mode: parse and size but do not submit */
  dryRun: boolean;
  /** Trading enabled switch */
  tradingEnabled: boolean;

  /** Log level */
  logLevel: "SILENT" | "ERROR" | "WARN" | "INFO" | "DEBUG";

  /** Base currency for equity (default USDT) */
  baseCurrency: string;

  /** State file path for idempotency */
  stateFilePath: string;

  /** Directory for persistent log files (signals, trades, bot). */
  logDir: string;

  /** Days to retain log files (default 90). */
  logRetentionDays: number;
}
