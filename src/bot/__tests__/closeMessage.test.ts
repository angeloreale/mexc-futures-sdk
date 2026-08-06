import { formatPositionCloseMessage, PositionCloseResult } from "../closeMessage";

function makeResult(overrides?: Partial<PositionCloseResult>): PositionCloseResult {
  return {
    status: "success",
    queriedId: "12345",
    symbol: "BTC_USDT",
    positionType: 1, // long
    leverage: 10,
    volume: 1,
    price: 69000,
    orderId: "abc123",
    currency: "USDT",
    ...overrides,
  };
}

describe("formatPositionCloseMessage", () => {
  it("includes realized PNL when available on a successful close", () => {
    const text = formatPositionCloseMessage(
      makeResult({ realisedPnl: 176.7, pnlPercent: 5.12 })
    );

    expect(text).toContain("POSITION CLOSED");
    expect(text).toContain("Realized PNL: +176.70 USDT (+5.12%)");
    expect(text).toContain("Close Order: <code>abc123</code>");
  });

  it("shows negative PNL with a minus sign", () => {
    const text = formatPositionCloseMessage(
      makeResult({ positionType: 2, realisedPnl: -3.2, pnlPercent: -0.5 })
    );

    expect(text).toContain("SHORT");
    expect(text).toContain("Realized PNL: -3.20 USDT (-0.50%)");
  });

  it("omits the PNL line entirely when it is not available", () => {
    const text = formatPositionCloseMessage(makeResult());

    expect(text).toContain("POSITION CLOSED");
    expect(text).not.toContain("Realized PNL");
  });

  it("omits the PNL line when the value is non-finite", () => {
    const text = formatPositionCloseMessage(
      makeResult({ realisedPnl: NaN, pnlPercent: NaN })
    );

    expect(text).not.toContain("Realized PNL");
  });
});
