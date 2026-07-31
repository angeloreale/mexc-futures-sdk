import { TradeSignal } from "./types";

/**
 * Regexes for signal formats:
 *   BUY TAOUSDT@187.54 SL 185.13 TP 188.81
 *   BUY ZECUSDT EP 460 SL 459.41 TP1 467.72
 *   SELL BTCUSDT@65000 SL 66000 TP1 64000 TP2 63000 TP3 62000
 *   BUY ETHUSDT@3500 SL 3400
 *   BUY ZECUSDT SL 459.41 TP1 467.72 TP2 468.80 TP3 471.42  (market — no @/EP)
 *   BUY BNBUSDT@571.22 SL 569.68 TP1 571.49 TP2 572.21 R2  (with risk override)
 *
 * SIGNAL_REGEX captures (with @price or EP price):
 *   1: action (BUY|SELL)
 *   2: symbol (e.g. TAOUSDT, USDJPY)
 *   3: entry price
 *   4: SL price
 *   5: rest of line for TP + risk extraction
 *
 * SIGNAL_REGEX_MARKET captures (market — no entry price):
 *   1: action (BUY|SELL)
 *   2: symbol
 *   3: SL price
 *   4: rest of line for TP + risk extraction
 */
const SIGNAL_REGEX =
  /\b(BUY|SELL)\s+([A-Z][A-Z0-9]{2,19})@(\d+(?:\.\d+)?)\s+SL\s+(\d+(?:\.\d+)?)(.*)/i;

const SIGNAL_REGEX_MARKET =
  /\b(BUY|SELL)\s+([A-Z][A-Z0-9]{2,19})\s+SL\s+(\d+(?:\.\d+)?)(.*)/i;

/**
 * Extract one or more TP values from the remainder of the signal line.
 * Supports: TP 100, TP1 100 TP2 200, TP1 100 TP2 200 TP3 300
 */
const TP_REGEX = /TP\d*\s+(\d+(?:\.\d+)?)/gi;

/**
 * Extract an optional risk percentage marker: R<number> (e.g. R2.5 = 2.5%, R6 = 6%).
 * Must appear as a standalone token (word boundary). Range 0–6.
 */
const RISK_REGEX = /\bR(\d+(?:\.\d+)?)\b/i;

/**
 * Extract an optional plan-order validity marker: V<number> (e.g. V7 = 7 days).
 * Must appear as a standalone token (word boundary).
 *   V1 or no V → executeCycle 1 (24 hours, default)
 *   V7        → executeCycle 2 (7 days)
 */
const VALIDITY_REGEX = /\bV(\d+)\b/i;

/**
 * Try to parse a trade signal from a single line of text.
 * Returns null if the line is not a recognizable signal.
 */
export function parseSignal(
  text: string,
  messageId?: number,
  chatId?: number | string,
  timestamp?: number
): TradeSignal | null {
  if (!text || typeof text !== "string") return null;

  // Normalize whitespace but preserve case for regex
  const cleaned = text.replace(/\s+/g, " ").trim();

  // Normalize "EP 460" → "@460" so both EP and @ formats work with the same regex
  const epNormalized = cleaned.replace(/\s+EP\s+(\d+(?:\.\d+)?)\b/i, "@$1");

  // Try @price regex first
  let match = epNormalized.match(SIGNAL_REGEX);
  let isMarketEntry = false;

  if (!match) {
    // Try market-entry regex (no @/EP)
    match = cleaned.match(SIGNAL_REGEX_MARKET);
    isMarketEntry = true;
  }

  if (!match) return null;

  const action = match[1].toUpperCase() as "BUY" | "SELL";
  const rawSymbol = match[2].toUpperCase();

  // Market entry uses 0 as sentinel; @price/EP uses the captured entry price
  const entry = isMarketEntry ? 0 : parseFloat(match[3]);
  const slIdx = isMarketEntry ? 3 : 4;
  const sl = parseFloat(match[slIdx]);
  const tpSection = match[slIdx + 1] || "";

  // Validate SL is a positive finite number
  if (!isFinite(sl) || sl <= 0) return null;

  // Validate entry is a positive finite number (skip for market — resolved later)
  if (!isMarketEntry && (!isFinite(entry) || entry <= 0)) return null;

  // Validate SL direction relative to entry (skip for market — entry unknown)
  // If direction is wrong, log an error but still process the signal — the user
  // may have a specific strategy in mind.
  if (!isMarketEntry) {
    if (action === "BUY" && sl >= entry) {
      console.error(
        `⚠️ [Parser] SL direction warning: BUY ${rawSymbol}@${entry} SL=${sl} — SL should be below entry for longs`
      );
    }
    if (action === "SELL" && sl <= entry) {
      console.error(
        `⚠️ [Parser] SL direction warning: SELL ${rawSymbol}@${entry} SL=${sl} — SL should be above entry for shorts`
      );
    }
  }

  // Strip risk marker before TP extraction so it doesn't interfere
  const riskPercentOverride = parseRiskOverride(tpSection);

  // Parse optional validity marker (V7 = 7 days, V1 or absent = 24h)
  const executeCycle = parseValidity(tpSection);

  // Extract TP values
  const tpValues: number[] = [];
  let tpMatch;
  while ((tpMatch = TP_REGEX.exec(tpSection)) !== null) {
    const tp = parseFloat(tpMatch[1]);
    if (isFinite(tp) && tp > 0) {
      tpValues.push(tp);
    }
  }
  // Reset lastIndex for the global regex
  TP_REGEX.lastIndex = 0;

  // Validate TP direction relative to entry (skip for market — entry unknown)
  // If direction is wrong, log an error but still process the signal.
  if (!isMarketEntry) {
    for (const tp of tpValues) {
      if (action === "BUY" && tp <= entry) {
        console.error(
          `⚠️ [Parser] TP direction warning: BUY ${rawSymbol}@${entry} TP=${tp} — TP should be above entry for longs`
        );
      }
      if (action === "SELL" && tp >= entry) {
        console.error(
          `⚠️ [Parser] TP direction warning: SELL ${rawSymbol}@${entry} TP=${tp} — TP should be below entry for shorts`
        );
      }
    }
  }

  return {
    raw: text,
    action,
    rawSymbol,
    entry,
    sl,
    tp: tpValues, // may be empty — caller should apply default TP ratio
    orderType: isMarketEntry ? "market" : "trigger",
    riskPercentOverride,
    executeCycle,
    messageId,
    chatId,
    timestamp,
  };
}

/**
 * Parse an optional risk percentage marker from the tail of a signal line.
 * E.g. R2.5 → 2.5 (meaning 2.5%), R6 → 6%. Valid range 0–6.
 * Returns the percentage as a float, or undefined if absent.
 */
function parseRiskOverride(tail: string): number | undefined {
  const m = tail.match(RISK_REGEX);
  if (m) {
    const pct = parseFloat(m[1]);
    if (isFinite(pct) && pct >= 0 && pct <= 6) {
      return pct;
    }
  }
  return undefined;
}

/**
 * Parse an optional plan-order validity marker from the tail of a signal line.
 * E.g. V7 → executeCycle 2 (7 days), anything else → 1 (24 hours).
 * Returns executeCycle (1 or 2), or undefined if absent.
 */
function parseValidity(tail: string): 1 | 2 | undefined {
  const m = tail.match(VALIDITY_REGEX);
  if (m) {
    const days = parseInt(m[1], 10);
    if (days >= 7) return 2; // 7+ days → executeCycle 2
    return 1; // default 24h
  }
  return undefined;
}

/**
 * Parse zero or more trade signals from a raw text message.
 *
 * Supports multi-line messages where each line contains one signal:
 * ```
 * SELL TAOUSDT@190.08 SL 198.84 TP1 188.89 TP2 188.25 TP 188.07
 * BUY USDCNH@6.77059 SL 6.76867 TP1 6.7714 TP2 6.7727 TP3 6.7744
 * BUY BNBUSDT@571.22 SL 569.68 TP1 571.49 TP2 572.21 TP3 573.32
 * ```
 *
 * Returns an array of parsed signals (empty if no signals found).
 */
export function parseSignals(
  text: string,
  messageId?: number,
  chatId?: number | string,
  timestamp?: number
): TradeSignal[] {
  if (!text || typeof text !== "string") return [];

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const signals: TradeSignal[] = [];
  for (const line of lines) {
    const signal = parseSignal(line, messageId, chatId, timestamp);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

/**
 * Attempt to convert a raw symbol (e.g. "TAOUSDT", "BTCUSDT") into MEXC
 * contract format (e.g. "TAO_USDT", "BTC_USDT").
 *
 * Uses a list of known quote currencies and picks the longest match from the end.
 * Returns null if no known quote currency suffix is found.
 */
const QUOTE_CURRENCIES = ["USDT", "USDC", "BTC", "ETH"];

export function normalizeSymbol(rawSymbol: string): string | null {
  const upper = rawSymbol.toUpperCase();

  // Already in MEXC format
  if (upper.includes("_")) return upper;

  // Try longest suffix match
  for (const quote of QUOTE_CURRENCIES) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      const base = upper.slice(0, upper.length - quote.length);
      return `${base}_${quote}`;
    }
  }

  return null;
}
