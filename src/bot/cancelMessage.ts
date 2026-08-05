/**
 * Result of a `CANCEL {SYMBOL} {DIRECTION}` command.
 */
export interface CancelOrdersResult {
  status: "success" | "dry-run" | "disabled" | "no-orders" | "partial" | "error";
  /** Contract symbol (e.g. "ETH_USDT"). */
  symbol: string;
  /** Direction: 1=LONG, 2=SHORT. */
  direction: "LONG" | "SHORT";
  /** Number of plan orders found matching the filter. */
  found: number;
  /** Number of plan orders successfully cancelled. */
  cancelled: number;
  /** Number of plan orders that failed to cancel. */
  failed: number;
  /** Error description (when status is "error"). */
  error?: string;
  /** List of cancelled plan-order IDs (for success/partial). */
  cancelledIds?: string[];
  /** List of failed plan-order IDs with reasons. */
  failedDetails?: { id: string; reason: string }[];
}

/**
 * Build the Telegram message for a `CANCEL {SYMBOL} {DIRECTION}` result.
 * Rendered with HTML parse mode.
 */
export function formatCancelOrdersMessage(
  res: CancelOrdersResult
): string {
  switch (res.status) {
    case "disabled":
      return [
        `⚠️ <b>TRADING DISABLED</b>`,
        ``,
        `Cannot cancel <b>${res.symbol} ${res.direction}</b> — trading is disabled.`,
      ].join("\n");

    case "dry-run":
      return [
        `🧪 <b>[DRY RUN] Would cancel</b>`,
        ``,
        `🪙 <b>${res.symbol}</b> · ${res.direction}`,
        `Pending trigger orders found: <b>${res.found}</b>`,
        `(no actual cancellation — dry-run mode)`,
      ].join("\n");

    case "no-orders":
      return [
        `ℹ️ <b>NO PENDING ORDERS</b>`,
        ``,
        `No untriggered ${res.direction} plan orders found for <b>${res.symbol}</b>.`,
      ].join("\n");

    case "success":
      return [
        `✅ <b>CANCELLED</b>`,
        ``,
        `🪙 <b>${res.symbol}</b> · ${res.direction}`,
        `Cancelled: <b>${res.cancelled}</b> of ${res.found} order(s)`,
        res.cancelledIds
          ? `\nIDs: ${res.cancelledIds.map((id) => `<code>${id}</code>`).join(" ")}`
          : "",
      ].join("\n");

    case "partial":
      const failLines =
        res.failedDetails?.map(
          (f) => `  • <code>${f.id}</code> — ${f.reason}`
        ) ?? [];
      return [
        `⚠️ <b>PARTIALLY CANCELLED</b>`,
        ``,
        `🪙 <b>${res.symbol}</b> · ${res.direction}`,
        `Cancelled: <b>${res.cancelled}</b> / ${res.found} order(s)`,
        `Failed: ${res.failed}`,
        ...(failLines.length > 0 ? ["", ...failLines] : []),
        res.cancelledIds && res.cancelledIds.length > 0
          ? `\nCancelled IDs: ${res.cancelledIds.map((id) => `<code>${id}</code>`).join(" ")}`
          : "",
      ].join("\n");

    case "error":
      return [
        `❌ <b>CANCEL FAILED</b>`,
        ``,
        `<b>${res.symbol}</b> · ${res.direction}`,
        `${res.error ?? "unknown error"}`,
      ].join("\n");
  }
}
