import type { ResolvedTrade } from "./types";
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
 * Format a signed number with an explicit +/- prefix (e.g. "+176.70", "-3.20").
 * Non-finite → "—".
 */
function fmtSigned(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${fmt(Math.abs(n), digits)}`;
}

/**
 * Format a base-currency amount (volume × contractSize) for the hedge-net
 * line, e.g. "1" or "0.6". Trims trailing zeros; non-finite → "—".
 */
function fmtBase(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

/**
 * Estimated gross profit (in quote currency) if price reaches the given
 * take-profit target, before fees. Positive for both LONG and SHORT.
 *
 * Accounts for contractSize: profit = volume × contractSize × |tp − entry|
 *
 * @param preciseEntry Optional precise (unrounded) entry price from the signal.
 *   When provided, uses this instead of the exchange-rounded t.entry for more
 *   accurate estimates.
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
 * Estimated gross loss (in quote currency) if price reaches the stop-loss,
 * expressed as a positive magnitude (before fees).
 *
 * loss = volume × contractSize × |entry − sl|
 *
 * @param preciseEntry Optional precise (unrounded) entry price from the signal.
 * @param preciseSl   Optional precise (unrounded) stop-loss from the signal.
 */
function estimateSlLoss(
  t: ResolvedTrade,
  volume: number,
  preciseEntry?: number,
  preciseSl?: number
): number {
  const entry = preciseEntry ?? t.entry;
  const sl = preciseSl ?? t.stopLossPrice;
  return volume * (t.contractSize || 1) * Math.abs(entry - sl);
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
  opts?: { useLimitTpSl?: boolean },
  preciseEntry?: number
): { entryFee: number; exitFee: number; total: number } | null {
  const taker = t.takerFeeRate;
  const maker = t.makerFeeRate;
  if (typeof taker !== "number" || typeof maker !== "number") return null;

  const cs = t.contractSize || 1;
  const isMarketEntry = t.signal.orderType !== "trigger";
  const entryRate = isMarketEntry ? taker : maker;
  const exitRate =
    opts?.useLimitTpSl === true && isMarketEntry ? maker : taker;

  const entryPrice = preciseEntry ?? t.entry;
  const entryFee = volume * cs * entryPrice * entryRate;
  const exitFee = volume * cs * exitPrice * exitRate;
  return { entryFee, exitFee, total: entryFee + exitFee };
}

/**
 * Estimated realized PNL (net of fees) as a percentage of the initial margin,
 * mirroring the PNL monitor's pnlPercent = realisedPnl / margin * 100.
 *
 * @param preciseEntry Optional precise (unrounded) entry price.
 */
function estimatePnlPercent(
  t: ResolvedTrade,
  volume: number,
  netPnl: number,
  preciseEntry?: number
): number {
  const cs = t.contractSize || 1;
  const entry = preciseEntry ?? t.entry;
  const margin = (volume * cs * entry) / t.leverage;
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
 * @param opts     Display options (limit/maker TP/SL active, dry-run marker, pending queue)
 */
export interface QueuedOrderLine {
  /** Operator-facing queue ID (e.g. "Q1") */
  id: string;
  /** MEXC symbol (e.g. "ETH_USDT") */
  symbol: string;
  /** "LONG" or "SHORT" */
  sideLabel: string;
  /** Entry price for the queued order */
  entry: number;
  /** Take-profit price for the queued order */
  tp: number;
  /** Stop-loss price for the queued order */
  sl: number;
  /** Order volume in contracts */
  volume: number;
  /** Contract size (base units per contract) */
  contractSize?: number;
}

export function formatTradeConfirmationMessage(
  t: ResolvedTrade,
  currency: string,
  opts?: {
    useLimitTpSl?: boolean;
    dryRun?: boolean;
    queue?: QueuedOrderLine[];
  }
): string {
  const dir = t.side === 1 ? "LONG" : "SHORT";
  const marginMode = t.openType === 1 ? "Isolated" : "Cross";
  const isTrigger = t.signal.orderType === "trigger";

  // Use precise (unrounded) values from the signal for display and PNL
  // estimates.  The sizer rounds prices to the exchange's priceScale for
  // order submission, but the confirmation should show the values the user
  // entered (or the exact ticker price for market entries).
  const preciseEntry = t.signal.entry;
  const preciseSl = t.signal.sl;

  const typeLabel = isTrigger
    ? `🔔 Trigger entry @ ${fmtPrice(preciseEntry)}`
    : `💹 Market entry @ ${fmtPrice(preciseEntry)}`;
  const cs = t.contractSize || 1;
  const volume = t.volume;

  // Expected TP / SL figures.  Use the signal's original TP values for
  // full precision; fall back to the sizer's (possibly default) TP when
  // the signal carried none.
  const tps =
    t.signal.tp.length > 0
      ? t.signal.tp
      : t.allTpTargets.length > 0
        ? t.allTpTargets
        : [t.takeProfitPrice];

  const grossSlLoss = estimateSlLoss(t, volume, preciseEntry, preciseSl);

  // Net-of-fee realized PNL at the SL (null when fee rates are unknown).
  const slFees = estimateFees(t, volume, preciseSl, opts, preciseEntry);
  const netSlPnl = slFees ? -grossSlLoss - slFees.total : null;

  const slPnlLine = netSlPnl !== null
    ? `Est. net loss: <b>${fmtSigned(netSlPnl)}</b> ${currency} (${fmt(estimatePnlPercent(t, volume, netSlPnl, preciseEntry), 1)}%) · incl. fees`
    : `Est. loss: ~${fmtSigned(-grossSlLoss)} ${currency} (${fmt(estimatePnlPercent(t, volume, -grossSlLoss, preciseEntry), 1)}%) · before fees`;

  // One header + PNL line per TP target.
  const tpBlock: string[] = [];
  let tpFees: { total: number; entryFee: number; exitFee: number } | null = null;
  for (let i = 0; i < tps.length; i++) {
    const tp = tps[i];
    const gross = estimateTpProfit(t, volume, tp, preciseEntry);
    const fees = estimateFees(t, volume, tp, opts, preciseEntry);
    if (i === 0) tpFees = fees;
    const pnlLine = fees
      ? `   Est. net profit: <b>${fmtSigned(gross - fees.total)}</b> ${currency} (${fmt(estimatePnlPercent(t, volume, gross - fees.total, preciseEntry), 1)}%) · incl. fees`
      : `   Est. profit: ~${fmt(gross)} ${currency} (${fmt(estimatePnlPercent(t, volume, gross, preciseEntry), 1)}%) · before fees`;
    const header = tps.length > 1
      ? `📍 TP${i + 1}: <b>${fmtPrice(tp)}</b>`
      : `📍 Expected TP: <b>${fmtPrice(tp)}</b>`;
    tpBlock.push(header, pnlLine);
  }

  const risk = t.riskAmount;
  const notional = volume * cs * preciseEntry;

  // Fee breakdown line (when known) — uses the first TP's exit leg.
  const feesLine =
    tpFees && slFees
      ? `🧾 Est. fees: ${fmt(tpFees.total)} ${currency} (${fmt(tpFees.entryFee)} entry + ${fmt(tpFees.exitFee)} exit)`
      : null;

  const dryRunTag = opts?.dryRun ? ` · 🧪 DRY RUN` : "";

  // Queue listing (with per-order IDs for CANCEL {ID}).
  let queueLine: string | null = null;
  if (opts?.queue && opts.queue.length > 0) {
    const rows = opts.queue
      .map(
        (q) =>
          `  <code>${q.id}</code> · ${q.symbol} ${q.sideLabel} · @ ${fmtPrice(q.entry)}`
      )
      .join("\n");

    // Hedge net: when the same symbol is queued in BOTH directions, show the
    // net exposure (volume × contractSize, in base units) for that symbol.
    const hedgeLines: string[] = [];
    const bySymbol = new Map<string, QueuedOrderLine[]>();
    for (const q of opts.queue) {
      const arr = bySymbol.get(q.symbol) ?? [];
      arr.push(q);
      bySymbol.set(q.symbol, arr);
    }
    for (const [symbol, entries] of bySymbol) {
      const longs = entries.filter((e) => e.sideLabel === "LONG");
      const shorts = entries.filter((e) => e.sideLabel === "SHORT");
      if (longs.length === 0 || shorts.length === 0) continue;
      const cs = entries[0].contractSize ?? 1;
      const base = symbol.includes("_") ? symbol.split("_")[0] : "";
      const unit = base ? ` ${base}` : "";
      const longBase = longs.reduce((s, e) => s + e.volume * cs, 0);
      const shortBase = shorts.reduce((s, e) => s + e.volume * cs, 0);
      const net = longBase - shortBase;
      const netLabel =
        Math.abs(net) < 1e-12
          ? "<b>fully hedged</b>"
          : `<b>${net > 0 ? "LONG" : "SHORT"} ${fmtBase(Math.abs(net))}${unit}</b>`;
      hedgeLines.push(
        `🧮 <b>Hedge net:</b> ${symbol} · LONG ${fmtBase(longBase)}${unit} − SHORT ${fmtBase(shortBase)}${unit} → ${netLabel}`
      );

      // Hedge PNL: combined PNL if price moves to each side's TP, with both
      // legs valued at the same reference price (gross, before fees).
      //   ▲ price rises to the LONG leg's TP (longs profit, shorts lose)
      //   ▼ price falls to the SHORT leg's TP (shorts profit, longs lose)
      const longRef = longs[0].tp;
      const shortRef = shorts[0].tp;
      const upPnl =
        longs.reduce((s, e) => s + (e.tp - e.entry) * e.volume * cs, 0) +
        shorts.reduce((s, e) => s + (e.entry - longRef) * e.volume * cs, 0);
      const downPnl =
        shorts.reduce((s, e) => s + (e.entry - e.tp) * e.volume * cs, 0) +
        longs.reduce((s, e) => s + (shortRef - e.entry) * e.volume * cs, 0);
      hedgeLines.push(
        `🧮 <b>Hedge PNL:</b> ▲ <b>${fmtSigned(upPnl)}</b> ${currency} (LONG TP) · ▼ <b>${fmtSigned(downPnl)}</b> ${currency} (SHORT TP) · before fees`
      );
    }

    queueLine =
      `📋 <b>Queue (${opts.queue.length})</b>:\n${rows}` +
      (hedgeLines.length > 0 ? `\n${hedgeLines.join("\n")}` : "") +
      `\n   Send <code>CONFIRM ORDERS</code> to place all · <code>CANCEL {ID}</code> to remove one`;
  }

  const lines = [
    `🧾 <b>TRADE CONFIRMATION</b>${dryRunTag}`,
    ``,
    `🪙 <b>${t.mexcSymbol}</b> · ${dir} · ${t.leverage}x · ${marginMode}`,
    typeLabel,
    ``,
    ...tpBlock,
    `📉 Expected SL: <b>${fmtPrice(preciseSl)}</b>`,
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
