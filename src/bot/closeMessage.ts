import { fmtPrice, fmtAmount, fmtSigned } from "../utils/numbers";

/**
 * Result of a `Close {orderId}` command.
 */
export interface PositionCloseResult {
  status: "success" | "dry-run" | "unknown" | "not-open" | "disabled" | "error";
  /** The order ID / identifier the user typed. */
  queriedId: string;
  /** MEXC contract symbol (populated when resolved). */
  symbol?: string;
  /** Position direction (populated when resolved). */
  positionType?: 1 | 2;
  /** Leverage (populated when resolved). */
  leverage?: number;
  /** Closed volume (contracts). */
  volume?: number;
  /** Execution price. */
  price?: number;
  /** Close order ID returned by MEXC. */
  orderId?: string;
  /** Error description. */
  error?: string;
  /** Percentage of position closed (only set for partial closes, e.g. 30 for 30%). */
  closePercent?: number;
  /** Realized PNL for the closed position (net of fees), when available. */
  realisedPnl?: number;
  /** Realized PNL as a percentage of the position's initial margin, when available. */
  pnlPercent?: number;
  /** Quote currency (e.g. "USDT") used for the PNL display. */
  currency?: string;
}

/**
 * Build the Telegram message for a `Close {orderId}` result.
 * Rendered with HTML parse mode.
 */
export function formatPositionCloseMessage(
  res: PositionCloseResult
): string {
  switch (res.status) {
    case "unknown":
      return [
        `❌ <b>CLOSE FAILED</b>`,
        ``,
        `No order found for <code>${res.queriedId}</code>.`,
      ].join("\n");

    case "disabled":
      return [
        `⚠️ <b>TRADING DISABLED</b>`,
        ``,
        `Cannot close <code>${res.queriedId}</code> — trading is disabled.`,
      ].join("\n");

    case "not-open":
      return [
        `ℹ️ <b>POSITION NOT OPEN</b>`,
        ``,
        `Order <code>${res.queriedId}</code> (${res.symbol ?? "?"}) has no open position to close.`,
      ].join("\n");

    case "dry-run":
      return [
        `🧪 <b>[DRY RUN] Would close</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${res.positionType === 1 ? "LONG" : "SHORT"} · ${res.leverage ?? "?"}x`,
        `Vol: ${fmtAmount((res.volume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)}${res.closePercent ? ` (${res.closePercent}% partial)` : ""}`,
        `Order: <code>${res.queriedId}</code>`,
      ].join("\n");

    case "error":
      return [
        `❌ <b>CLOSE FAILED</b>`,
        ``,
        `<code>${res.queriedId}</code> (${res.symbol ?? "?"}) — ${res.error ?? "unknown error"}`,
      ].join("\n");

    case "success": {
      const dir = res.positionType === 1 ? "LONG" : "SHORT";
      const partialLabel = res.closePercent ? ` (${res.closePercent}% PARTIAL)` : "";
      const lines = [
        `✅ <b>POSITION CLOSED${partialLabel}</b>`,
        ``,
        `🪙 <b>${res.symbol ?? "?"}</b> · ${dir} · ${res.leverage ?? "?"}x`,
        `Vol: ${fmtAmount((res.volume ?? 0) as number)} @ ${fmtPrice((res.price ?? 0) as number)}`,
      ];
      // Include realized PNL when it was resolved (full closes with a history
      // record available). Non-finite → omitted entirely.
      if (Number.isFinite(res.realisedPnl)) {
        const icon = (res.realisedPnl as number) >= 0 ? "📈" : "📉";
        const cur = res.currency ? ` ${res.currency}` : "";
        const pct = Number.isFinite(res.pnlPercent)
          ? ` (${fmtSigned(res.pnlPercent as number)}%)`
          : "";
        lines.push(
          `${icon} <b>Realized PNL: ${fmtSigned(res.realisedPnl as number)}${cur}${pct}</b>`
        );
      }
      lines.push(`Close Order: <code>${res.orderId ?? "?"}</code>`);
      return lines.join("\n");
    }
  }
}
