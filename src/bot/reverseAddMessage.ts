import { fmtPrice } from "../utils/numbers";

/**
 * Result of a `REVERSE {orderId}` command.
 */
export interface ReverseResult {
  status: "success" | "dry-run" | "unknown" | "not-open" | "disabled" | "error";
  /** The order ID / identifier the user typed. */
  queriedId: string;
  /** MEXC contract symbol. */
  symbol?: string;
  /** Original position direction. */
  originalDirection?: "LONG" | "SHORT";
  /** New opposite position direction. */
  newDirection?: "LONG" | "SHORT";
  /** Leverage. */
  leverage?: number;
  /** Closed volume (contracts). */
  closedVolume?: number;
  /** New order volume (contracts). */
  newVolume?: number;
  /** Current market price. */
  price?: number;
  /** Close order ID. */
  closeOrderId?: string;
  /** New open order ID. */
  newOrderId?: string;
  /** Stop-loss for the new position. */
  stopLoss?: number;
  /** Take-profit for the new position. */
  takeProfit?: number;
  /** Error description. */
  error?: string;
}

/**
 * Result of an `ADD TO {orderId} {risk%}` command.
 */
export interface AddToResult {
  status: "success" | "dry-run" | "unknown" | "not-open" | "disabled" | "error";
  /** The order ID / identifier the user typed. */
  queriedId: string;
  /** MEXC contract symbol. */
  symbol?: string;
  /** Position direction. */
  direction?: "LONG" | "SHORT";
  /** Leverage. */
  leverage?: number;
  /** Added volume (contracts). */
  addedVolume?: number;
  /** Total position volume after addition. */
  totalVolume?: number;
  /** Current market price. */
  price?: number;
  /** New order ID. */
  orderId?: string;
  /** Risk percent used. */
  riskPercent?: number;
  /** Stop-loss (unchanged). */
  stopLoss?: number;
  /** Take-profit (unchanged). */
  takeProfit?: number;
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
 * Build the Telegram message for a `REVERSE {orderId}` result.
 * Rendered with HTML parse mode.
 */
export function formatReverseMessage(res: ReverseResult): string {
  switch (res.status) {
    case "unknown":
      return [
        `❌ <b>REVERSE FAILED</b>`,
        ``,
        `No order found for <code>${res.queriedId}</code>.`,
      ].join("\n");

    case "disabled":
      return [
        `⚠️ <b>TRADING DISABLED</b>`,
        ``,
        `Cannot reverse <code>${res.queriedId}</code> — trading is disabled.`,
      ].join("\n");

    case "not-open":
      return [
        `ℹ️ <b>POSITION NOT OPEN</b>`,
        ``,
        `Order <code>${res.queriedId}</code> (${res.symbol ?? "?"}) has no open position to reverse.`,
      ].join("\n");

    case "dry-run":
      return [
        `🧪 <b>[DRY RUN] Would reverse</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${res.originalDirection ?? "?"} → ${res.newDirection ?? "?"} · ${res.leverage ?? "?"}x`,
        `Close: ${fmt((res.closedVolume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)}`,
        `New: ${fmt((res.newVolume ?? 0) as number)} SL=${fmtPrice((res.stopLoss ?? 0) as number)} TP=${fmtPrice((res.takeProfit ?? 0) as number)}`,
        `Order: <code>${res.queriedId}</code>`,
      ].join("\n");

    case "error":
      return [
        `❌ <b>REVERSE FAILED</b>`,
        ``,
        `<code>${res.queriedId}</code> (${res.symbol ?? "?"}) — ${res.error ?? "unknown error"}`,
      ].join("\n");

    case "success":
      return [
        `🔄 <b>POSITION REVERSED</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${res.originalDirection ?? "?"} → ${res.newDirection ?? "?"} · ${res.leverage ?? "?"}x`,
        `Closed: ${fmt((res.closedVolume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)}`,
        `Opened: ${fmt((res.newVolume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)}`,
        `SL: ${fmtPrice((res.stopLoss ?? 0) as number)} · TP: ${fmtPrice((res.takeProfit ?? 0) as number)}`,
        `Close Order: <code>${res.closeOrderId ?? "?"}</code>`,
        `New Order: <code>${res.newOrderId ?? "?"}</code>`,
      ].join("\n");
  }
}

/**
 * Build the Telegram message for an `ADD TO {orderId} {risk%}` result.
 * Rendered with HTML parse mode.
 */
export function formatAddToMessage(res: AddToResult): string {
  switch (res.status) {
    case "unknown":
      return [
        `❌ <b>ADD TO FAILED</b>`,
        ``,
        `No order found for <code>${res.queriedId}</code>.`,
      ].join("\n");

    case "disabled":
      return [
        `⚠️ <b>TRADING DISABLED</b>`,
        ``,
        `Cannot add to <code>${res.queriedId}</code> — trading is disabled.`,
      ].join("\n");

    case "not-open":
      return [
        `ℹ️ <b>POSITION NOT OPEN</b>`,
        ``,
        `Order <code>${res.queriedId}</code> (${res.symbol ?? "?"}) has no open position to add to.`,
      ].join("\n");

    case "dry-run":
      return [
        `🧪 <b>[DRY RUN] Would add to position</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${res.direction ?? "?"} · ${res.leverage ?? "?"}x`,
        `Added: ${fmt((res.addedVolume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)} (${fmt((res.riskPercent ?? 0) as number, 1)}% risk)`,
        `Total: ${fmt((res.totalVolume ?? 0) as number)} · SL=${fmtPrice((res.stopLoss ?? 0) as number)} TP=${fmtPrice((res.takeProfit ?? 0) as number)}`,
        `Order: <code>${res.queriedId}</code>`,
      ].join("\n");

    case "error":
      return [
        `❌ <b>ADD TO FAILED</b>`,
        ``,
        `<code>${res.queriedId}</code> (${res.symbol ?? "?"}) — ${res.error ?? "unknown error"}`,
      ].join("\n");

    case "success":
      return [
        `➕ <b>ADDED TO POSITION</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${res.direction ?? "?"} · ${res.leverage ?? "?"}x`,
        `Added: ${fmt((res.addedVolume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)} (${fmt((res.riskPercent ?? 0) as number, 1)}% risk)`,
        `Total: ${fmt((res.totalVolume ?? 0) as number)} · SL=${fmtPrice((res.stopLoss ?? 0) as number)} TP=${fmtPrice((res.takeProfit ?? 0) as number)}`,
        `Order: <code>${res.orderId ?? "?"}</code>`,
      ].join("\n");
  }
}
