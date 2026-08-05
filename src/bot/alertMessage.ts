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

  return [
    `${icon} <b>POSITION ALERT — ${pct}% toward ${alert.target}</b>`,
    ``,
    `🪙 <b>${alert.symbol}</b> · ${dir} · ${alert.leverage}x`,
    `Entry: ${fmtPrice(alert.entry)} → Now: ${fmtPrice(alert.currentPrice)}`,
    `🎯 ${targetLabel} @ ${fmtPrice(targetPrice)} — ${pct}% of the way`,
  ].join("\n");
}
