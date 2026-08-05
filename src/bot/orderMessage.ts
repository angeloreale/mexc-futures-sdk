import type { ResolvedTrade, TradeRecord } from "./types";

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
 * Estimated gross profit (in quote currency) if price reaches the given
 * take-profit target, before fees. Positive for both LONG and SHORT.
 *
 * Accounts for contractSize: profit = volume × contractSize × |tp − entry|
 */
function estimateTpProfit(t: ResolvedTrade, volume: number, tp: number): number {
  const diff = t.side === 1 ? tp - t.entry : t.entry - tp;
  return volume * (t.contractSize || 1) * diff;
}

/**
 * Estimated profit as a percentage of the initial margin, mirroring the PNL
 * monitor's pnlPercent = realisedPnl / margin * 100.
 *
 * Margin also accounts for contractSize.
 */
function estimateTpProfitPercent(
  t: ResolvedTrade,
  volume: number,
  tp: number
): number {
  const cs = t.contractSize || 1;
  const margin = (volume * cs * t.entry) / t.leverage;
  if (margin <= 0) return NaN;
  return (estimateTpProfit(t, volume, tp) / margin) * 100;
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
  // A signal with multiple TPs is split into one order per TP, so each record
  // carries its own submitted volume and TP (falls back to the full-trade
  // values for single-TP orders).
  const orderVolume = record.orderVolume ?? t.volume;
  const orderTp = record.orderTp ?? t.takeProfitPrice;
  const dir = t.side === 1 ? "LONG" : "SHORT";
  const marginMode = t.openType === 1 ? "Isolated" : "Cross";
  const isTrigger = t.signal.orderType === "trigger";
  const typeLabel = isTrigger
    ? `🔔 Pending trigger @ ${fmt(t.entry)}`
    : `💹 Market entry @ ${fmt(t.entry)}`;
  const tpProfit = estimateTpProfit(t, orderVolume, orderTp);
  const tpProfitPct = estimateTpProfitPercent(t, orderVolume, orderTp);
  const orderRisk = t.volume > 0 ? t.riskAmount * (orderVolume / t.volume) : 0;

  const lines = [
    `🚀 <b>ORDER PLACED</b>`,
    ``,
    `🪙 <b>${t.mexcSymbol}</b> · ${dir} · ${t.leverage}x · ${marginMode}`,
    typeLabel,
    `SL: ${fmt(t.stopLossPrice)} · TP: ${fmt(orderTp)}`,
    `Vol: ${fmt(orderVolume)} · Notional: ~${fmt(orderVolume * (t.contractSize || 1) * t.entry)} ${currency}`,
    `Risk: ${fmt(orderRisk)} ${currency} (${(t.riskPercent * 100).toFixed(1)}%)`,
    `Est. profit @ TP ${fmt(orderTp)}: ~${fmt(tpProfit)} ${currency} (${fmt(tpProfitPct, 1)}%)`,
    ``,
    `Order ID: <code>${record.orderId}</code>`,
  ];

  return lines.join("\n");
}
