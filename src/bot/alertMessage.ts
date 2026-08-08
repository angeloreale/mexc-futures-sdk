import type { PositionAlert } from "./summaryMonitor";
import { fmtPrice } from "../utils/numbers";

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
 * Format a signed number with an explicit +/- prefix. Non-finite → "—".
 */
function fmtSigned(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${fmt(Math.abs(n), digits)}`;
}

/**
 * Build the Telegram message for a >50%-toward-SL/TP alert.
 * Rendered with HTML parse mode.
 */
export function formatPositionAlertMessage(alert: PositionAlert): string {
  const dir = alert.positionType === 1 ? "LONG" : "SHORT";
  const isSl = alert.target === "SL";
  const icon = isSl ? "🚨" : "🎯";
  const targetLabel = isSl ? "Stop-loss" : "Take-profit";
  const targetPrice = isSl ? alert.sl : alert.tp;
  const pct = Math.round(alert.progress * 100);

  const pnlLine = Number.isFinite(alert.pnl)
    ? `\n📈 Current PNL: <b>${fmtSigned(alert.pnl)} USDT</b>`
    : "";

  return [
    `${icon} <b>POSITION ALERT — ${pct}% toward ${alert.target}</b>`,
    ``,
    `🪙 <b>${alert.symbol}</b> · ${dir} · ${alert.leverage}x`,
    `Entry: ${fmtPrice(alert.entry)} → Now: ${fmtPrice(alert.currentPrice)}`,
    `🎯 ${targetLabel} @ ${fmtPrice(targetPrice)} — ${pct}% of the way${pnlLine}`,
  ].join("\n");
}
