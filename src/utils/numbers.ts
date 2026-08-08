/**
 * Coerce an unknown value (number or numeric string, as MEXC often returns
 * numeric fields as strings, e.g. `"7.558390449899999999"`) to a finite
 * number. Non-numeric / non-finite / empty-string values become NaN.
 */
export function toFiniteNumber(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") return NaN;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Add thousands separators to the integer portion of a decimal string.
 * e.g. "1234567.89" → "1,234,567.89"
 */
function addCommas(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a price for display with high precision.
 *
 * Preserves the asset's actual precision up to 10 decimal places (most MEXC
 * contracts support several decimals, e.g. 0.00001234) instead of truncating
 * to 2 decimals for larger prices, adds thousands separators, and keeps at
 * least 2 decimal places for readability.
 *
 * Uses toFixed for deterministic decimal control — does NOT rely on
 * toLocaleString options which may be ignored in Node.js/Electron
 * runtimes without full ICU data.
 *
 * Non-finite numbers return "—".
 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // Use toFixed(15) for deterministic, ICU-independent decimal control.
  // Then strip trailing zeros (keeping at least 2 decimals).
  let fixed = n.toFixed(15);
  const dotIdx = fixed.indexOf(".");
  let intPart = fixed.slice(0, dotIdx);
  let frac = fixed.slice(dotIdx + 1);

  // Strip trailing zeros, but keep at least 2 decimal places.
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");

  // Add thousands separators to the integer part (handles negatives).
  const sign = intPart.startsWith("-") ? "-" : "";
  const absInt = sign ? intPart.slice(1) : intPart;
  return sign + addCommas(absInt) + "." + frac;
}

/**
 * Format a monetary amount (e.g. PNL, fees, risk) for display.
 *
 * Adapts decimal places to the value's magnitude: small amounts (< 1) get
 * up to 6 decimals, medium amounts (< 1000) get up to 4, large amounts get
 * 2. Adds thousands separators.
 *
 * Non-finite numbers return "—".
 *
 * @param n          The amount to format.
 * @param maxDigits  Override the maximum decimal places (default auto-detected).
 */
export function fmtAmount(n: number, maxDigits?: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);

  let maxDec: number;
  if (maxDigits !== undefined) {
    maxDec = maxDigits;
  } else if (abs < 1) {
    maxDec = 6;
  } else if (abs < 1000) {
    maxDec = 4;
  } else {
    maxDec = 2;
  }

  const fixed = n.toFixed(maxDec);
  const dotIdx = fixed.indexOf(".");
  let intPart = fixed.slice(0, dotIdx);
  let frac = fixed.slice(dotIdx + 1);

  // Strip trailing zeros, but keep at least 2 decimal places for readability.
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");

  const sign = intPart.startsWith("-") ? "-" : "";
  const absInt = sign ? intPart.slice(1) : intPart;
  return sign + addCommas(absInt) + "." + frac;
}

/**
 * Format a signed number with an explicit +/- prefix (e.g. "+176.70", "-3.20").
 * Non-finite → "—". Delegates to fmtAmount for decimal precision.
 */
export function fmtSigned(n: number, maxDigits?: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${fmtAmount(Math.abs(n), maxDigits)}`;
}
