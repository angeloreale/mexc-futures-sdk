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
 * Format a price for display with high precision.
 *
 * Preserves the asset's actual precision up to 10 decimal places (most MEXC
 * contracts support several decimals, e.g. 0.00001234) instead of truncating
 * to 2 decimals for larger prices, adds thousands separators, and keeps at
 * least 2 decimal places for readability.
 *
 * Non-finite numbers return "—".
 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // Up to 10 decimals so high-precision prices are not truncated.
  let s = n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 10,
  });
  // Trim trailing zeros beyond the 2nd decimal, but keep at least 2 decimals.
  const dot = s.indexOf(".");
  if (dot !== -1) {
    let frac = s.slice(dot + 1).replace(/0+$/, "");
    if (frac.length < 2) frac = frac.padEnd(2, "0");
    s = s.slice(0, dot) + "." + frac;
  }
  return s;
}
