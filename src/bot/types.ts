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
  /** Entry price from the signal; 0 means market entry (resolved later via ticker) */
  entry: number;
  /** Stop-loss price */
  sl: number;
  /** Take-profit price(s); at least one is always present after normalization */
  tp: number[];
  /** Order type: "market" when no @/EP given, "trigger" when explicit entry provided */
  orderType: "market" | "trigger";
  /** Optional per-order risk override as a percentage (0-6, e.g. 2.5 = 2.5%). Falls back to config.riskPercent when absent. */
  riskPercentOverride?: number;
  /** Optional per-order leverage override (1-200, e.g. 200 = 200x). Falls back to config.leverage when absent. */
  leverageOverride?: number;
  /** Optional plan-order validity: 1 = 24h (default), 2 = 7 days. Set via V7 marker. */
  executeCycle?: 1 | 2;
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
  /** Risk percentage applied for this trade (0.01 = 1%), may differ from config default */
  riskPercent: number;
  /** Risk amount (equity * riskPercent) */
  riskAmount: number;
  /** Minimum order volume (contracts) */
  minVol: number;
  /** Volume scale (decimal places) */
  volScale: number;
  /** Volume step unit */
  volUnit: number;
  /** Current market price at time of resolution (used to determine trigger direction) */
  currentPrice: number;
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
  /**
   * Volume actually submitted for THIS order. Differs from resolved.volume
   * when a signal with multiple TPs is split into one order per TP.
   */
  orderVolume?: number;
  /**
   * Take-profit price attached to THIS order. Differs from resolved when a
   * signal with multiple TPs is split into one order per TP.
   */
  orderTp?: number;
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

  /** Directory for persistent log files (signals, trades, bot, ticker, http). */
  logDir: string;

  /** Days to retain log files (default 90). */
  logRetentionDays: number;

  /** Telegram channel/chat ID to receive position-close PNL notifications (empty = disabled). */
  pnlNotificationChannel: string;

  /** How often (seconds) to poll MEXC for closed positions (min 5, default 30). */
  positionMonitorIntervalSeconds: number;

  /** Telegram channel/chat ID for periodic position summaries (empty = falls back to pnlNotificationChannel). */
  summaryNotificationChannel: string;

  /** How often (hours) to send the position summary (default 8). */
  summaryIntervalHours: number;

  /** Trailing window (hours) for PNL max/min stats in the summary (default 4). */
  summaryWindowHours: number;

  /** Token-bucket burst capacity for MEXC API requests — max requests sent immediately before throttling (default 3). */
  orderRateCapacity: number;

  /** Milliseconds between API request refills — sustained rate ≈ 1000/orderRateIntervalMs req/s (default 200). */
  orderRateIntervalMs: number;
}
