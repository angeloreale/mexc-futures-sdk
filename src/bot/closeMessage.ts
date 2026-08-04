/**
 * Result of a `Close {orderId}` command.
 */
export interface PositionCloseResult {
  status: "success" | "dry-run" | "unknown" | "not-open" | "disabled" | "error";
  /** The order ID / identifier the user typed. */
  queriedId: string;
  /** MEXC contract symbol (populated when resolved). */
  symbol?: string;
  /** Position direction (populated when resolved). */
  positionType?: 1 | 2;
  /** Leverage (populated when resolved). */
  leverage?: number;
  /** Closed volume (contracts). */
  volume?: number;
  /** Execution price. */
  price?: number;
  /** Close order ID returned by MEXC. */
  orderId?: string;
  /** Error description. */
  error?: string;
}

/**
 * Format a number for display (e.g. "1,234.56"). Non-finite → "—".
 */
function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Build the Telegram message for a `Close {orderId}` result.
 * Rendered with HTML parse mode.
 */
export function formatPositionCloseMessage(
  res: PositionCloseResult
): string {
  switch (res.status) {
    case "unknown":
      return [
        `❌ <b>CLOSE FAILED</b>`,
        ``,
        `No order found for <code>${res.queriedId}</code>.`,
      ].join("\n");

    case "disabled":
      return [
        `⚠️ <b>TRADING DISABLED</b>`,
        ``,
        `Cannot close <code>${res.queriedId}</code> — trading is disabled.`,
      ].join("\n");

    case "not-open":
      return [
        `ℹ️ <b>POSITION NOT OPEN</b>`,
        ``,
        `Order <code>${res.queriedId}</code> (${res.symbol ?? "?"}) has no open position to close.`,
      ].join("\n");

    case "dry-run":
      return [
        `🧪 <b>[DRY RUN] Would close</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${res.positionType === 1 ? "LONG" : "SHORT"} · ${res.leverage ?? "?"}x`,
        `Vol: ${fmt((res.volume ?? 0) as number)} @ ${fmt((res.price ?? 0) as number)}`,
        `Order: <code>${res.queriedId}</code>`,
      ].join("\n");

    case "error":
      return [
        `❌ <b>CLOSE FAILED</b>`,
        ``,
        `<code>${res.queriedId}</code> (${res.symbol ?? "?"}) — ${res.error ?? "unknown error"}`,
      ].join("\n");

    case "success": {
      const dir = res.positionType === 1 ? "LONG" : "SHORT";
      return [
        `✅ <b>POSITION CLOSED</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${dir} · ${res.leverage ?? "?"}x`,
        `Vol: ${fmt((res.volume ?? 0) as number)} @ ${fmt((res.price ?? 0) as number)}`,
        `Close Order: <code>${res.orderId ?? "?"}</code>`,
      ].join("\n");
    }
  }
}
