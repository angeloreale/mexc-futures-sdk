import type { TradeRecord } from "./types";

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
 * Build the Telegram message sent right after an order is placed/executed.
 *
 * @param record The trade record from a successful execution
 * @param currency Quote currency (e.g. "USDT")
 * Rendered with HTML parse mode.
 */
export function formatOrderPlacedMessage(
  record: TradeRecord,
  currency: string
): string {
  const t = record.resolved;
  const dir = t.side === 1 ? "LONG" : "SHORT";
  const marginMode = t.openType === 1 ? "Isolated" : "Cross";
  const isTrigger = t.signal.orderType === "trigger";
  const typeLabel = isTrigger
    ? `🔔 Pending trigger @ ${fmt(t.entry)}`
    : `💹 Market entry @ ${fmt(t.entry)}`;

  const lines = [
    `🚀 <b>ORDER PLACED</b>`,
    ``,
    `🪙 <b>${t.mexcSymbol}</b> · ${dir} · ${t.leverage}x · ${marginMode}`,
    typeLabel,
    `SL: ${fmt(t.stopLossPrice)} · TP: ${t.allTpTargets
      .map((tp) => fmt(tp))
      .join(", ")}`,
    `Vol: ${fmt(t.volume)} · Notional: ~${fmt(t.volume * t.entry)} ${currency}`,
    `Risk: ${fmt(t.riskAmount)} ${currency} (${(t.riskPercent * 100).toFixed(1)}%)`,
    ``,
    `Order ID: <code>${record.orderId}</code>`,
  ];

  return lines.join("\n");
}
