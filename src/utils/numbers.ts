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
 * Format a price for display with adaptive decimal precision.
 * Small prices (altcoins like 0.59) get up to 10 decimals;
 * larger prices (BTC ~60k) get fewer.
 *
 * Non-finite numbers return "—".
 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let digits: number;
  if (abs < 0.001) {
    digits = 10;
  } else if (abs < 1) {
    digits = 6;
  } else if (abs < 100) {
    digits = 4;
  } else {
    digits = 2;
  }
  // Strip trailing zeros after decimal, but keep at least 2 decimal places
  // for prices >= 1.
  const formatted = n.toFixed(digits);
  if (abs >= 1) return formatted;
  // For sub-1 prices, strip trailing zeros but keep at least 2 decimals
  return formatted.replace(/0+$/, "").replace(/\.$/, ".00");
}
