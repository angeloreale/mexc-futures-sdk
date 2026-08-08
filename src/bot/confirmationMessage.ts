import type { ResolvedTrade } from "./types";

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
 * Estimated gross profit (in quote currency) if price reaches the given
 * take-profit target, before fees. Positive for both LONG and SHORT.
 *
 * Accounts for contractSize: profit = volume × contractSize × |tp − entry|
 */
function estimateTpProfit(t: ResolvedTrade, volume: number, tp: number): number {
  const diff = t.side === 1 ? tp - t.entry : t.entry - tp;
  return volume * (t.contractSize || 1) * diff;
}

/**
 * Estimated gross loss (in quote currency) if price reaches the stop-loss,
 * expressed as a positive magnitude (before fees).
 *
 * loss = volume × contractSize × |entry − sl|
 */
function estimateSlLoss(t: ResolvedTrade, volume: number): number {
  return volume * (t.contractSize || 1) * Math.abs(t.entry - t.stopLossPrice);
}

/**
 * Estimated trading fees for a round trip (entry + exit) in quote currency.
 * Returns null when the contract fee rates are unknown.
 *
 * Entry fees use the taker rate (market/plan entries fill as taker). Exit fees
 * use the maker rate only when limit (maker) TP/SL is active on a market
 * entry; otherwise both legs are charged the taker rate.
 */
function estimateFees(
  t: ResolvedTrade,
  volume: number,
  exitPrice: number,
  opts?: { useLimitTpSl?: boolean }
): { entryFee: number; exitFee: number; total: number } | null {
  const taker = t.takerFeeRate;
  const maker = t.makerFeeRate;
  if (typeof taker !== "number" || typeof maker !== "number") return null;

  const cs = t.contractSize || 1;
  const isMarketEntry = t.signal.orderType !== "trigger";
  const entryRate = isMarketEntry ? taker : maker;
  const exitRate =
    opts?.useLimitTpSl === true && isMarketEntry ? maker : taker;

  const entryFee = volume * cs * t.entry * entryRate;
  const exitFee = volume * cs * exitPrice * exitRate;
  return { entryFee, exitFee, total: entryFee + exitFee };
}

/**
 * Estimated realized PNL (net of fees) as a percentage of the initial margin,
 * mirroring the PNL monitor's pnlPercent = realisedPnl / margin * 100.
 */
function estimatePnlPercent(
  t: ResolvedTrade,
  volume: number,
  netPnl: number
): number {
  const cs = t.contractSize || 1;
  const margin = (volume * cs * t.entry) / t.leverage;
  if (margin <= 0) return NaN;
  return (netPnl / margin) * 100;
}

/**
 * Build the Telegram confirmation message sent to the allowed channel BEFORE a
 * trade is placed. Shows the expected TP and expected SL, and — when the
 * contract fee rates are known — the estimated realized PNL net of fees at
 * both levels. Rendered with HTML parse mode.
 *
 * @param t        The fully resolved trade (post-sizing, pre-execution)
 * @param currency Quote currency (e.g. "USDT")
 * @param opts     Display options (limit/maker TP/SL active, dry-run marker, pending queue size)
 */
export function formatTradeConfirmationMessage(
  t: ResolvedTrade,
  currency: string,
  opts?: { useLimitTpSl?: boolean; dryRun?: boolean; pendingCount?: number }
): string {
  const dir = t.side === 1 ? "LONG" : "SHORT";
  const marginMode = t.openType === 1 ? "Isolated" : "Cross";
  const isTrigger = t.signal.orderType === "trigger";
  const typeLabel = isTrigger
    ? `🔔 Trigger entry @ ${fmt(t.entry)}`
    : `💹 Market entry @ ${fmt(t.entry)}`;
  const cs = t.contractSize || 1;
  const volume = t.volume;

  // Expected TP / SL figures.
  const tp = t.takeProfitPrice;
  const sl = t.stopLossPrice;
  const grossTpProfit = estimateTpProfit(t, volume, tp);
  const grossSlLoss = estimateSlLoss(t, volume);

  // Net-of-fee realized PNL at each level (null when fee rates are unknown).
  const tpFees = estimateFees(t, volume, tp, opts);
  const slFees = estimateFees(t, volume, sl, opts);
  const netTpPnl = tpFees ? grossTpProfit - tpFees.total : null;
  const netSlPnl = slFees ? -grossSlLoss - slFees.total : null;

  const tpPnlLine = netTpPnl !== null
    ? `Est. net profit: <b>${fmtSigned(netTpPnl)}</b> ${currency} (${fmt(estimatePnlPercent(t, volume, netTpPnl), 1)}%) · incl. fees`
    : `Est. profit: ~${fmt(grossTpProfit)} ${currency} (${fmt(estimatePnlPercent(t, volume, grossTpProfit), 1)}%) · before fees`;

  const slPnlLine = netSlPnl !== null
    ? `Est. net loss: <b>${fmtSigned(netSlPnl)}</b> ${currency} (${fmt(estimatePnlPercent(t, volume, netSlPnl), 1)}%) · incl. fees`
    : `Est. loss: ~${fmtSigned(-grossSlLoss)} ${currency} (${fmt(estimatePnlPercent(t, volume, -grossSlLoss), 1)}%) · before fees`;

  const risk = t.riskAmount;
  const notional = volume * cs * t.entry;

  // Fee breakdown line (when known).
  const feesLine =
    tpFees && slFees
      ? `🧾 Est. fees: ${fmt(tpFees.total)} ${currency} (${fmt(tpFees.entryFee)} entry + ${fmt(tpFees.exitFee)} exit)`
      : null;

  const dryRunTag = opts?.dryRun ? ` · 🧪 DRY RUN` : "";

  // Queue status (when the pending queue size is known).
  const queueLine =
    opts?.pendingCount !== undefined
      ? `📋 Queue: ${opts.pendingCount} order(s) pending — send CONFIRM ORDERS to place`
      : null;

  const lines = [
    `🧾 <b>TRADE CONFIRMATION</b>${dryRunTag}`,
    ``,
    `🪙 <b>${t.mexcSymbol}</b> · ${dir} · ${t.leverage}x · ${marginMode}`,
    typeLabel,
    ``,
    `📍 Expected TP: <b>${fmt(tp)}</b>`,
    `   ${tpPnlLine}`,
    `📉 Expected SL: <b>${fmt(sl)}</b>`,
    `   ${slPnlLine}`,
    ``,
    `💵 Risk: ${fmt(risk)} ${currency} (${(t.riskPercent * 100).toFixed(1)}%) · Notional: ~${fmt(notional)} ${currency}`,
    feesLine ? `${feesLine}` : null,
    queueLine ? `${queueLine}` : null,
    ``,
    `⏳ Queued — awaiting <b>CONFIRM ORDERS</b>`,
  ];

  return lines.filter((l): l is string => l !== null).join("\n");
}
