import type { SignalResolutionEvent } from "./types";

/**
 * Format a number for display. Non-finite → "—".
 */
function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Format a timestamp as a short date/time string.
 */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Build the Telegram message for a TP or SL hit on a tracked signal.
 *
 * Rendered with HTML parse mode.
 */
export function formatSignalResolutionMessage(event: SignalResolutionEvent): string {
  const s = event.signal;
  const dir = s.action === "BUY" ? "LONG" : "SHORT";

  if (event.type === "tp") {
    const tpNum = event.tpIndex !== undefined ? `TP${event.tpIndex + 1}` : "TP";
    const lines = [
      `🎯 <b>${tpNum} HIT</b>`,
      ``,
      `🪙 <b>${s.mexcSymbol}</b> · ${dir}`,
      `Entry: ${fmt(s.entry)} → TP: ${fmt(event.hitPrice)}`,
      ``,
      `──`,
      `📅 Signal: ${fmtTime(s.createdAt)}`,
    ];
    return lines.join("\n");
  }

  // SL hit
  const lines = [
    `🛑 <b>SL HIT</b>`,
    ``,
    `🪙 <b>${s.mexcSymbol}</b> · ${dir}`,
    `Entry: ${fmt(s.entry)} → SL: ${fmt(event.hitPrice)}`,
    ``,
    `──`,
    `📅 Signal: ${fmtTime(s.createdAt)}`,
  ];
  return lines.join("\n");
}
