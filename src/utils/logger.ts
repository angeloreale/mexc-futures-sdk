import * as fs from "fs";
import * as path from "path";

export enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
}

export type LogLevelString = keyof typeof LogLevel;

export interface LoggerOptions {
  level?: LogLevelString | LogLevel;
  /** Directory for persistent log files (signals, trades, bot). */
  logDir?: string;
  /** Days to retain log files before auto-deleting. Default 90. */
  retentionDays?: number;
}

/**
 * Structured logger with console output + daily-rotating file persistence.
 *
 * Produces three log file types under `logDir`:
 *   signals-YYYY-MM-DD.log  — one JSON line per parsed signal
 *   trades-YYYY-MM-DD.log   — one JSON line per trade execution
 *   bot-YYYY-MM-DD.log      — mirror of all console output
 *
 * Files older than `retentionDays` are deleted on construction.
 */
export class Logger {
  private level: LogLevel;
  private logDir: string | null;
  private retentionDays: number;
  private currentDate: string = "";

  /** Cached write streams keyed by filename (closed & reopened on date change). */
  private streams: Map<string, fs.WriteStream> = new Map();

  constructor(opts: LoggerOptions | LogLevelString | LogLevel = LogLevel.WARN) {
    // Backward-compat: accept plain LogLevelString/LogLevel
    if (typeof opts === "string" || typeof opts === "number") {
      opts = { level: opts as LogLevelString };
    }
    const level = opts.level ?? LogLevel.WARN;
    if (typeof level === "string") {
      this.level =
        LogLevel[level.toUpperCase() as LogLevelString] ?? LogLevel.WARN;
    } else {
      this.level = level;
    }

    this.logDir = opts.logDir
      ? path.resolve(opts.logDir)
      : null;
    this.retentionDays = opts.retentionDays ?? 90;

    if (this.logDir) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.cleanupOldFiles();
    }
  }

  // ── public API ──────────────────────────────────────────────────────

  getLevel(): LogLevel {
    return this.level;
  }

  isDebugEnabled(): boolean {
    return this.level >= LogLevel.DEBUG;
  }

  debug(...args: any[]) { this.log(LogLevel.DEBUG, ...args); }
  info(...args: any[])  { this.log(LogLevel.INFO,  ...args); }
  warn(...args: any[])  { this.log(LogLevel.WARN,  ...args); }
  error(...args: any[]) { this.log(LogLevel.ERROR, ...args); }

  /**
   * Persist a parsed signal to the signals-YYYY-MM-DD.log file.
   * Called whenever the bot successfully parses a trade signal from Telegram.
   */
  logSignal(signal: {
    action: string;
    rawSymbol: string;
    entry: number;
    sl: number;
    tp: number[];
    chatId?: number | string;
    messageId?: number;
    timestamp?: number;
    raw?: string;
  }): void {
    this.appendJson("signals", {
      ts: new Date().toISOString(),
      action: signal.action,
      rawSymbol: signal.rawSymbol,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      chatId: signal.chatId,
      messageId: signal.messageId,
      signalTs: signal.timestamp
        ? new Date(signal.timestamp * 1000).toISOString()
        : undefined,
      raw: signal.raw,
    });
  }

  /**
   * Persist a trade record to the trades-YYYY-MM-DD.log file.
   * Called after every trade attempt (successful or failed, dry-run or live).
   */
  logTrade(trade: {
    orderId: string;
    success: boolean;
    error?: string;
    symbol: string;
    side: string;
    volume: number;
    entry: number;
    sl: number;
    tp: number;
    leverage: number;
    openType: string;
    equity: number;
    riskAmount: number;
    dryRun: boolean;
    signalChatId?: number | string;
    signalMessageId?: number;
    signalRaw?: string;
  }): void {
    this.appendJson("trades", {
      ts: new Date().toISOString(),
      orderId: trade.orderId,
      success: trade.success,
      error: trade.error || null,
      symbol: trade.symbol,
      side: trade.side,
      volume: trade.volume,
      entry: trade.entry,
      sl: trade.sl,
      tp: trade.tp,
      leverage: trade.leverage,
      openType: trade.openType,
      equity: trade.equity,
      riskAmount: trade.riskAmount,
      dryRun: trade.dryRun,
      signalChatId: trade.signalChatId,
      signalMessageId: trade.signalMessageId,
      signalRaw: trade.signalRaw,
    });
  }

  /**
   * Persist an HTTP request/response record to the http-YYYY-MM-DD.log file.
   * Called by the axios interceptors for every outbound request, regardless of log level.
   */
  logHttp(record: {
    method: string;
    url: string;
    requestHeaders?: Record<string, string>;
    requestBody?: any;
    responseStatus?: number;
    responseBody?: any;
    error?: {
      message: string;
      code?: string | number;
      data?: any;
    };
    durationMs?: number;
  }): void {
    this.appendJson("http", {
      ts: new Date().toISOString(),
      method: record.method,
      url: record.url,
      requestHeaders: record.requestHeaders,
      requestBody: record.requestBody,
      responseStatus: record.responseStatus,
      responseBody: record.responseBody,
      error: record.error,
      durationMs: record.durationMs,
    });
  }

  /**
   * Persist a ticker (PNL polling) sample to the ticker-YYYY-MM-DD.log file.
   * Called on each summary-monitor sample cycle, one line per tracked position.
   */
  logTicker(sample: {
    positionId: string;
    symbol: string;
    positionType: number;
    openType: number;
    leverage: number;
    openAvgPrice: number;
    margin: number;
    /** Unrealized PNL at sample time */
    pnl: number;
    /** Unix ms timestamp of the sample */
    sampleTs: number;
  }): void {
    this.appendJson("ticker", {
      ts: new Date().toISOString(),
      positionId: sample.positionId,
      symbol: sample.symbol,
      positionType: sample.positionType,
      openType: sample.openType,
      leverage: sample.leverage,
      openAvgPrice: sample.openAvgPrice,
      margin: sample.margin,
      pnl: sample.pnl,
      sampleTs: sample.sampleTs,
    });
  }

  /**
   * Flush and close all file streams. Call during graceful shutdown.
   */
  async close(): Promise<void> {
    for (const [name, stream] of this.streams) {
      await new Promise<void>((resolve) => stream.end(resolve));
      this.streams.delete(name);
    }
  }

  // ── private ─────────────────────────────────────────────────────────

  private log(level: LogLevel, ...args: any[]) {
    if (this.level < level) return;

    const prefix = `[${LogLevel[level]}]`;
    const time = new Date().toISOString();
    const line = `${time} ${prefix} ${args.map((a) =>
      typeof a === "string" ? a : JSON.stringify(a)
    ).join(" ")}`;

    // Console output (unchanged)
    console.log(line);

    // Mirror to bot-YYYY-MM-DD.log
    this.appendLine("bot", line);
  }

  /** Write a single line to a daily-rotated log file. */
  private appendLine(category: string, line: string): void {
    if (!this.logDir) return;
    this.rotateIfNeeded();
    const filename = `${category}-${this.currentDate}.log`;
    const stream = this.getStream(filename);
    stream.write(line + "\n");
  }

  /** Write a JSON object (single line) to a daily-rotated log file. */
  private appendJson(category: string, obj: Record<string, unknown>): void {
    this.appendLine(category, JSON.stringify(obj));
  }

  private getStream(filename: string): fs.WriteStream {
    let stream = this.streams.get(filename);
    if (!stream) {
      stream = fs.createWriteStream(
        path.join(this.logDir!, filename),
        { flags: "a" }
      );
      this.streams.set(filename, stream);
    }
    return stream;
  }

  /** Check if the date has changed; if so, close old streams. */
  private rotateIfNeeded(): void {
    const today = this.dateStr();
    if (this.currentDate !== today) {
      // Close all existing streams
      for (const [name, stream] of this.streams) {
        stream.end();
        this.streams.delete(name);
      }
      this.currentDate = today;
    }
  }

  private dateStr(): string {
    // Returns YYYY-MM-DD in local timezone
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Delete log files older than retentionDays. */
  private cleanupOldFiles(): void {
    if (!this.logDir) return;
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const prefixRe = /^(signals|trades|bot|http|ticker)-(\d{4}-\d{2}-\d{2})\.log$/;

      for (const entry of fs.readdirSync(this.logDir)) {
        const match = entry.match(prefixRe);
        if (!match) continue;
        const fileDate = new Date(match[2]).getTime();
        if (fileDate < cutoff) {
          fs.unlinkSync(path.join(this.logDir, entry));
        }
      }
    } catch {
      // Non-fatal — don't crash the bot over log cleanup
    }
  }
}
