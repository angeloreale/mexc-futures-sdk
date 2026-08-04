import type { PositionSummary } from "./summaryMonitor";

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

const DIVIDER = "──────────────";

/**
 * Shorten a long numeric ID for compact display (e.g. "817027833053397504" →
 * "…397504"). Returns "—" for empty input.
 */
function shortId(id: string, tail = 6): string {
  if (!id) return "—";
  if (id.length <= tail + 1) return id;
  return `…${id.slice(-tail)}`;
}

/**
 * Build the Telegram message for the periodic position summary.
 * Includes open positions (with current / max / min PNL over the window,
 * plus their position IDs), pending STOP orders (one line each with their
 * order IDs), and the account balance + equity. HTML format.
 */
export function formatPositionSummaryMessage(summary: PositionSummary): string {
  const cur = summary.account.currency;
  const lines: string[] = [];

  lines.push(`📊 <b>POSITION SUMMARY</b>`);
  lines.push(`⏱️ Last ${summary.windowHours}h · report every ${summary.intervalHours}h`);
  lines.push(``);

  // ── Open positions ──────────────────────────────────────────────
  lines.push(`📂 <b>Open Positions (${summary.openPositions.length})</b>`);
  if (summary.openPositions.length === 0) {
    lines.push(`No open positions`);
  } else {
    for (const p of summary.openPositions) {
      const dir = p.positionType === 1 ? "LONG" : "SHORT";
      const icon = p.currentPnl >= 0 ? "🟢" : "🔴";
      lines.push(DIVIDER);
      lines.push(`${icon} <b>${p.symbol}</b> ${dir} · ${p.leverage}x`);
      lines.push(`Entry: ${fmt(p.openAvgPrice)}`);
      lines.push(`PNL: <b>${fmtSigned(p.currentPnl)} ${cur}</b>`);
      lines.push(`   max ${fmtSigned(p.maxPnl)} / min ${fmtSigned(p.minPnl)} ${cur}`);
      lines.push(`🆔 ${p.positionId}`);
    }
  }
  lines.push(``);

  // ── Pending (STOP) orders ────────────────────────────────────────
  lines.push(`📌 <b>Pending Orders (${summary.pendingOrders.length})</b>`);
  if (summary.pendingOrders.length === 0) {
    lines.push(`No pending orders`);
  } else {
    for (const o of summary.pendingOrders) {
      const dir = o.side === 1 ? "LONG" : "SHORT";
      lines.push(
        `🟡 ${o.symbol} ${dir} · STOP @ ${fmt(o.triggerPrice)} · ${fmt(o.vol)} · <code>${shortId(o.orderId)}</code>`
      );
    }
  }
  lines.push(``);

  // ── Account ─────────────────────────────────────────────────────
  lines.push(`💼 Available: ${fmt(summary.account.availableBalance)} ${cur}`);
  lines.push(`📈 Equity: ${fmt(summary.account.equity)} ${cur}`);

  return lines.join("\n");
}
