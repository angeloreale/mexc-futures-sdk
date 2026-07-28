import { TradeSignal } from "./types";

/**
 * Regex for signal formats:
 *   BUY TAOUSDT@187.54 SL 185.13 TP 188.81
 *   SELL BTCUSDT@65000 SL 66000 TP1 64000 TP2 63000 TP3 62000
 *   BUY ETHUSDT@3500 SL 3400
 *
 * Captures:
 *   1: action (BUY|SELL)
 *   2: symbol (e.g. TAOUSDT, USDJPY)
 *   3: entry price
 *   4: SL price
 *   5: rest of line for TP extraction
 */
const SIGNAL_REGEX =
  /\b(BUY|SELL)\s+([A-Z0-9]{3,20})@(\d+(?:\.\d+)?)\s+SL\s+(\d+(?:\.\d+)?)(.*)/i;

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

  const match = cleaned.match(SIGNAL_REGEX);
  if (!match) return null;

  const action = match[1].toUpperCase() as "BUY" | "SELL";
  const rawSymbol = match[2].toUpperCase();
  const entry = parseFloat(match[3]);
  const sl = parseFloat(match[4]);
  const tpSection = match[5] || "";

  // Validate entry and SL are positive finite numbers
  if (!isFinite(entry) || entry <= 0) return null;
  if (!isFinite(sl) || sl <= 0) return null;

  // Validate SL direction relative to entry
  if (action === "BUY" && sl >= entry) return null; // SL must be below entry for longs
  if (action === "SELL" && sl <= entry) return null; // SL must be above entry for shorts

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

  // Validate TP direction if provided
  for (const tp of tpValues) {
    if (action === "BUY" && tp <= entry) return null; // TP must be above entry for longs
    if (action === "SELL" && tp >= entry) return null; // TP must be below entry for shorts
  }

  return {
    raw: text,
    action,
    rawSymbol,
    entry,
    sl,
    tp: tpValues, // may be empty — caller should apply default TP ratio
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
