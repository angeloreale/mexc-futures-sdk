import type {
  AccountSnapshot,
  ClosedPositionInfo,
} from "./pnlMonitor";

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
 * Format a signed number with an explicit +/- prefix (e.g. "+176.70", "-3.20").
 * Non-finite → "—".
 */
function fmtSigned(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${fmt(Math.abs(n), digits)}`;
}

/**
 * Build the Telegram message sent when a position closes.
 * Includes realized PNL (amount + % of initial margin), and the account's
 * available balance and equity after the close. Rendered with HTML parse mode.
 */
export function formatPositionClosedMessage(
  info: ClosedPositionInfo,
  account: AccountSnapshot
): string {
  const dir = info.positionType === 1 ? "LONG" : "SHORT";
  const marginMode = info.openType === 1 ? "Isolated" : "Cross";
  const icon = info.realisedPnl >= 0 ? "📈" : "📉";

  const lines = [
    `📊 <b>POSITION CLOSED</b>`,
    ``,
    `🪙 <b>${info.symbol}</b> · ${dir} · ${info.leverage}x · ${marginMode}`,
    `Entry: ${fmt(info.openAvgPrice)} → Exit: ${fmt(info.closeAvgPrice)}`,
    ``,
    `${icon} <b>Realized PNL: ${fmtSigned(info.realisedPnl)} ${account.currency} (${fmtSigned(info.pnlPercent)}%)</b>`,
    ``,
    `💼 Available: ${fmt(account.availableBalance)} ${account.currency}`,
    `📈 Equity: ${fmt(account.equity)} ${account.currency}`,
  ];

  return lines.join("\n");
}
