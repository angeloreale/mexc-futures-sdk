import type { ResolvedTrade, TradeRecord } from "./types";
import { fmtPrice, fmtAmount } from "../utils/numbers";

/**
 * Estimated gross profit (in quote currency) if price reaches the given
 * take-profit target, before fees. Positive for both LONG and SHORT.
 *
 * Accounts for contractSize: profit = volume × contractSize × |tp − entry|
 *
 * @param preciseEntry Optional precise (unrounded) entry price.
 */
function estimateTpProfit(
  t: ResolvedTrade,
  volume: number,
  tp: number,
  preciseEntry?: number
): number {
  const entry = preciseEntry ?? t.entry;
  const diff = t.side === 1 ? tp - entry : entry - tp;
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
  tp: number,
  preciseEntry?: number
): number {
  const cs = t.contractSize || 1;
  const entry = preciseEntry ?? t.entry;
  const margin = (volume * cs * entry) / t.leverage;
  if (margin <= 0) return NaN;
  return (estimateTpProfit(t, volume, tp, preciseEntry) / margin) * 100;
}

/**
 * Build the Telegram message sent right after an order is placed/executed.
 *
 * @param record The trade record from a successful execution
 * @param currency Quote currency (e.g. "USDT")
 * @param opts Optional display options (e.g. whether limit/maker TP/SL is active)
 * Rendered with HTML parse mode.
 */
export function formatOrderPlacedMessage(
  record: TradeRecord,
  currency: string,
  opts?: { useLimitTpSl?: boolean }
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

  // Use precise (unrounded) values from the signal for display.
  const preciseEntry = t.signal.entry;
  const preciseSl = t.signal.sl;

  const typeLabel = isTrigger
    ? `🔔 Pending trigger @ ${fmtPrice(preciseEntry)}`
    : `💹 Market entry @ ${fmtPrice(preciseEntry)}`;
  const useLimitTpSl = opts?.useLimitTpSl === true && !isTrigger;
  const tpProfit = estimateTpProfit(t, orderVolume, orderTp, preciseEntry);
  const tpProfitPct = estimateTpProfitPercent(t, orderVolume, orderTp, preciseEntry);
  const orderRisk = t.volume > 0 ? t.riskAmount * (orderVolume / t.volume) : 0;

  const lines = [
    `🚀 <b>ORDER PLACED</b>`,
    ``,
    `🪙 <b>${t.mexcSymbol}</b> · ${dir} · ${t.leverage}x · ${marginMode}`,
    typeLabel,
    `SL: ${fmtPrice(preciseSl)} · TP: ${fmtPrice(orderTp)}${useLimitTpSl ? ` 🛡️ Limit TP/SL` : ""}`,
    `Vol: ${fmtAmount(orderVolume)} · Notional: ~${fmtAmount(orderVolume * (t.contractSize || 1) * preciseEntry)} ${currency}`,
    `Risk: ${fmtAmount(orderRisk)} ${currency} (${(t.riskPercent * 100).toFixed(1)}%)`,
    `Est. profit @ TP ${fmtPrice(orderTp)}: ~${fmtAmount(tpProfit)} ${currency} (${fmtAmount(tpProfitPct, 1)}%)`,
    ``,
    `Order ID: <code>${record.orderId}</code>`,
  ];

  return lines.join("\n");
}
