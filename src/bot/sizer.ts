import { ContractDetail } from "../types/market";
import { BotConfig, TradeSignal, ResolvedTrade } from "./types";
import { Logger } from "../utils/logger";

/**
 * Calculate the order volume based on risk parameters and contract metadata.
 */
export function calculatePositionSize(
  signal: TradeSignal,
  contract: ContractDetail,
  equity: number,
  currentPrice: number,
  config: BotConfig,
  logger: Logger
): ResolvedTrade | null {
  const { entry, sl, action, tp: tpValues } = signal;

  // Guard: market entries must be resolved to a real price before sizing
  if (entry <= 0) {
    logger.warn("⚠️ Entry price is 0 (market unresolved) — cannot size position");
    return null;
  }

  // Compute stop distance (always positive)
  const stopDistance = Math.abs(entry - sl);
  if (stopDistance <= 0) {
    logger.warn("⚠️ Stop distance is zero — cannot size position");
    return null;
  }

  // Determine risk percentage: per-order riskPercentOverride (e.g. 2.5 → 2.5%) or config default
  const effectiveRiskPercent = signal.riskPercentOverride !== undefined
    ? signal.riskPercentOverride / 100
    : config.riskPercent;

  // Risk amount
  const riskAmount = equity * effectiveRiskPercent;
  logger.debug(
    `💰 Equity: ${equity}, Risk%: ${(effectiveRiskPercent * 100).toFixed(1)}%, Risk amount: ${riskAmount}`
  );

  // Determine effective leverage: per-order leverageOverride (e.g. L200) or
  // config default, clamped to the contract's allowed range.
  const requestedLeverage =
    signal.leverageOverride !== undefined ? signal.leverageOverride : config.leverage;
  const leverage = Math.min(
    Math.max(requestedLeverage, contract.minLeverage),
    contract.maxLeverage
  );
  if (signal.leverageOverride !== undefined && signal.leverageOverride !== leverage) {
    logger.info(
      `⚙️ Leverage override ${signal.leverageOverride}x clamped to ${leverage}x (contract ${contract.minLeverage}-${contract.maxLeverage})`
    );
  }

  // Calculate volume:
  // riskAmount = stopDistance * volume * contractSize
  // volume = riskAmount / (stopDistance * contractSize)
  const contractSize = contract.contractSize || 1;
  const rawVolume = riskAmount / (stopDistance * contractSize);

  // Round to contract volume precision
  const volScale = contract.volScale || 0;
  const volUnit = contract.volUnit || 1;
  let volume = Math.floor(rawVolume / volUnit) * volUnit;

  // Apply volScale rounding
  if (volScale > 0) {
    const factor = Math.pow(10, volScale);
    volume = Math.floor(volume * factor) / factor;
  }

  // Check min/max volume
  if (volume < contract.minVol) {
    const minNotional = contract.minVol * contractSize * entry;
    const requiredEquity = minNotional / leverage;
    logger.warn(
      `⚠️ Position too small: calculated ${volume} < min ${contract.minVol} for ${contract.symbol}. ` +
      `Min notional ≈ ${minNotional.toFixed(2)} USDT, ` +
      `needs ~${requiredEquity.toFixed(2)} USDT equity at ${leverage}x (have ${equity.toFixed(2)})`
    );
    return null;
  }
  if (volume > contract.maxVol) {
    logger.warn(
      `⚠️ Calculated volume ${volume} exceeds max ${contract.maxVol} for ${contract.symbol} — clamping`
    );
    volume = contract.maxVol;
  }

  // Check notional limit
  const notional = volume * contractSize * entry;
  if (notional > config.maxNotionalPerTrade) {
    logger.warn(
      `⚠️ Notional ${notional} exceeds max ${config.maxNotionalPerTrade} — reducing volume`
    );
    const maxVol = config.maxNotionalPerTrade / (contractSize * entry);
    volume = Math.floor(maxVol / volUnit) * volUnit;
    if (volScale > 0) {
      const factor = Math.pow(10, volScale);
      volume = Math.floor(volume * factor) / factor;
    }
    if (volume < contract.minVol) {
      logger.warn("⚠️ Volume below min after notional clamp — skipping");
      return null;
    }
  }

  // Determine side
  const side: 1 | 3 = action === "BUY" ? 1 : 3;

  // Round all prices to contract price precision (entry, SL, TP)
  const priceScale = contract.priceScale || 0;
  const pFactor = Math.pow(10, priceScale);
  const roundPrice = (p: number) => {
    if (priceScale > 0) {
      return Math.round(p * pFactor) / pFactor;
    }
    return p;
  };

  const roundedEntry = roundPrice(entry);
  const roundedSl = roundPrice(sl);

  // Determine TP targets
  let allTpTargets = [...tpValues];
  if (allTpTargets.length === 0) {
    // Default TP at config.defaultTpRatio * R from entry
    const tpDistance = stopDistance * config.defaultTpRatio;
    const defaultTp =
      action === "BUY" ? roundedEntry + tpDistance : roundedEntry - tpDistance;
    allTpTargets = [defaultTp];
    logger.info(
      `📍 No TP in signal — using default ${config.defaultTpRatio}R: ${defaultTp}`
    );
  }

  // Round TP targets
  allTpTargets = allTpTargets.map(roundPrice);

  // Primary TP is the first target
  const takeProfitPrice = allTpTargets[0];

  return {
    signal,
    mexcSymbol: contract.symbol,
    volume,
    side,
    leverage,
    openType: config.openType,
    entry: roundedEntry,
    stopLossPrice: roundedSl,
    takeProfitPrice,
    allTpTargets,
    equity,
    riskPercent: effectiveRiskPercent,
    riskAmount,
    minVol: contract.minVol,
    volScale: contract.volScale || 0,
    volUnit: contract.volUnit || 1,
    currentPrice,
    contractSize: contract.contractSize || 1,
    takerFeeRate: contract.takerFeeRate,
    makerFeeRate: contract.makerFeeRate,
  };
}
