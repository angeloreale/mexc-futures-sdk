import { TradeSignal } from "./types";

/**
 * Regexes for signal formats:
 *   BUY TAOUSDT@187.54 SL 185.13 TP 188.81
 *   BUY ZECUSDT EP 460 SL 459.41 TP1 467.72
 *   SELL BTCUSDT@65000 SL 66000 TP1 64000 TP2 63000 TP3 62000
 *   BUY ETHUSDT@3500 SL 3400
 *   BUY ZECUSDT SL 459.41 TP1 467.72 TP2 468.80 TP3 471.42  (market — no @/EP)
 *
 * SIGNAL_REGEX captures (with @price or EP price):
 *   1: action (BUY|SELL)
 *   2: symbol (e.g. TAOUSDT, USDJPY)
 *   3: entry price
 *   4: SL price
 *   5: rest of line for TP extraction
 *
 * SIGNAL_REGEX_MARKET captures (market — no entry price):
 *   1: action (BUY|SELL)
 *   2: symbol
 *   3: SL price
 *   4: rest of line for TP extraction
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
 * Try to parse a trade signal from a raw text message.
 * Returns null if the message is not a recognizable signal.
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
    messageId,
    chatId,
    timestamp,
  };
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
