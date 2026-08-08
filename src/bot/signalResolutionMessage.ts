import type { SignalResolutionEvent } from "./types";
import { fmtPrice, fmtAmount } from "../utils/numbers";

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
      `Entry: ${fmtPrice(s.entry)} → TP: ${fmtPrice(event.hitPrice)}`,
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
    `Entry: ${fmtPrice(s.entry)} → SL: ${fmtPrice(event.hitPrice)}`,
    ``,
    `──`,
    `📅 Signal: ${fmtTime(s.createdAt)}`,
  ];
  return lines.join("\n");
}
