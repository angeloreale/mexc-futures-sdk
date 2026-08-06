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
 * plus their position IDs), pending plan orders (one line each with their
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
      // Total estimated P&L at TP/SL. Winning positions show how far toward
      // the TP target the current PNL is; losing positions show how far toward
      // the SL (a positive %) instead of a misleading negative "% of TP".
      if (p.estTpPnl !== undefined && p.estSlPnl !== undefined) {
        const isWinning = p.currentPnl >= 0;
        const prog = isWinning ? p.tpProgress : p.slProgress;
        let pctLine = "";
        if (Number.isFinite(prog)) {
          const pct = (prog as number) * 100;
          pctLine = isWinning
            ? ` · <b>${fmtSigned(pct, 0)}%</b> of TP`
            : ` · <b>${fmt(Math.abs(pct), 0)}%</b> of SL`;
        }
        lines.push(
          `🎯 Est TP <b>${fmtSigned(p.estTpPnl)}</b> / SL <b>${fmtSigned(p.estSlPnl)}</b> ${cur}${pctLine}`
        );
      }
      // The position ID is the single identifier that works with the CLOSE
      // handler: it is always present on the open-positions API and uniquely
      // identifies the exact LONG/SHORT position (hedge mode can hold both on
      // one symbol), so `CLOSE {positionId}` never hits MEXC's "wrong
      // direction" error.
      lines.push(`🆔 <code>CLOSE ${p.positionId}</code>`);
    }
  }
  lines.push(``);

  // ── Daily PNL (realized + unrealized, with day-over-day tick) ─────
  const dp = summary.dailyPnl;
  lines.push(`📅 <b>Daily PNL</b> · ${dp.date}`);
  lines.push(`Realized: <b>${fmtSigned(dp.realized)}</b> ${cur}`);
  lines.push(`Unrealized: <b>${fmtSigned(dp.unrealized)}</b> ${cur} <i>(open positions)</i>`);
  const totalStr = Number.isFinite(dp.total) ? fmtSigned(dp.total) : "—";
  const tickStr =
    dp.tick !== null && Number.isFinite(dp.tick)
      ? ` · tick <b>${fmtSigned(dp.tick)}</b> vs ${dp.prevDate ?? "prev day"}`
      : "";
  lines.push(`Total: <b>${totalStr}</b> ${cur}${tickStr}`);
  lines.push(``);

  // ── Pending plan orders (TP/SL + trigger entries) ───────────────
  lines.push(`📌 <b>Pending Orders (${summary.pendingOrders.length})</b>`);
  if (summary.pendingOrders.length === 0) {
    lines.push(`No pending orders`);
  } else {
    for (const o of summary.pendingOrders) {
      const dir = o.side === 1 || o.side === 4 ? "LONG" : "SHORT";
      const id = `<code>${shortId(o.orderId)}</code>`;
      if (o.kind === "STOP") {
        const arrow = o.triggerType === 1 ? "≥" : "≤";
        lines.push(
          `🟡 ${o.symbol} ${dir} · STOP ${arrow}${fmt(o.triggerPrice)} · ${fmt(o.vol)} · ${id}`
        );
      } else {
        // TP/SL pair. For a long: TP fires on a rise (≥), SL on a fall (≤).
        // For a short: TP fires on a fall (≤), SL on a rise (≥).
        const long = o.positionType === 1;
        const tp = Number.isFinite(o.takeProfitPrice)
          ? `TP ${long ? "≥" : "≤"}${fmt(o.takeProfitPrice)}`
          : "";
        const sl = Number.isFinite(o.stopLossPrice)
          ? `SL ${long ? "≤" : "≥"}${fmt(o.stopLossPrice)}`
          : "";
        lines.push(
          `🟡 ${o.symbol} ${dir} · ${[tp, sl].filter(Boolean).join(" / ")} · ${fmt(o.vol)} · ${id}`
        );
      }
    }
  }
  lines.push(``);

  // ── Account ─────────────────────────────────────────────────────
  lines.push(`💼 Available: ${fmt(summary.account.availableBalance)} ${cur}`);
  lines.push(`📈 Equity: ${fmt(summary.account.equity)} ${cur}`);

  return lines.join("\n");
}
