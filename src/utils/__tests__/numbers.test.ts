import { fmtPrice } from "../numbers";

describe("fmtPrice", () => {
  it("preserves fractional precision beyond 2 decimals", () => {
    expect(fmtPrice(67234.4567)).toBe("67,234.4567");
    expect(fmtPrice(187.54)).toBe("187.54");
    expect(fmtPrice(0.00001234)).toBe("0.00001234");
  });

  it("keeps thousands separators on large prices", () => {
    expect(fmtPrice(67000)).toBe("67,000.00");
    expect(fmtPrice(1884.95)).toBe("1,884.95");
  });

  it("trims trailing zeros beyond the 2nd decimal but keeps at least 2", () => {
    expect(fmtPrice(123.4)).toBe("123.40");
    expect(fmtPrice(0.5)).toBe("0.50");
    expect(fmtPrice(123)).toBe("123.00");
  });

  it("handles negative and non-finite values", () => {
    expect(fmtPrice(-0.1788)).toBe("-0.1788");
    expect(fmtPrice(-100.5)).toBe("-100.50");
    expect(fmtPrice(NaN)).toBe("—");
    expect(fmtPrice(Infinity)).toBe("—");
  });
});
