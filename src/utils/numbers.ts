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
