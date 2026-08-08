import { formatPositionAlertMessage } from "../alertMessage";
import { PositionAlert } from "../summaryMonitor";

function makeAlert(overrides?: Partial<PositionAlert>): PositionAlert {
  return {
    positionId: "12345",
    symbol: "BTC_USDT",
    positionType: 1, // LONG
    leverage: 10,
    entry: 67000,
    currentPrice: 67250,
    sl: 66800,
    tp: 67500,
    target: "TP",
    progress: 0.5,
    pnl: 125.0,
    computedPnl: 125.0,
    ...overrides,
  };
}

describe("formatPositionAlertMessage", () => {
  it("shows TP alert with progress and PNL for a long position", () => {
    const text = formatPositionAlertMessage(makeAlert());

    expect(text).toContain("POSITION ALERT");
    expect(text).toContain("50% toward TP");
    expect(text).toContain("BTC_USDT");
    expect(text).toContain("LONG");
    expect(text).toContain("10x");
    expect(text).toContain("Take-profit");
    expect(text).toContain("Current PNL: +125.00 USDT");
  });

  it("shows SL alert with negative PNL for a losing long", () => {
    const text = formatPositionAlertMessage(
      makeAlert({
        target: "SL",
        progress: 0.6,
        currentPrice: 66900,
        pnl: -50.0,
        computedPnl: -50.0,
      })
    );

    expect(text).toContain("60% toward SL");
    expect(text).toContain("Stop-loss");
    expect(text).toContain("Current PNL: -50.00 USDT");
  });

  it("shows TP alert for a short position", () => {
    const text = formatPositionAlertMessage(
      makeAlert({
        positionType: 2,
        entry: 3500,
        currentPrice: 3450,
        tp: 3400,
        sl: 3600,
        target: "TP",
        progress: 0.5,
        pnl: 75.0,
        computedPnl: 75.0,
      })
    );

    expect(text).toContain("SHORT");
    expect(text).toContain("Take-profit");
    expect(text).toContain("Current PNL: +75.00 USDT");
  });

  it("omits PNL line when pnl is not finite", () => {
    const text = formatPositionAlertMessage(
      makeAlert({ pnl: NaN, computedPnl: NaN })
    );

    expect(text).not.toContain("Current PNL:");
  });

  it("includes entry and current price", () => {
    const text = formatPositionAlertMessage(makeAlert());

    expect(text).toContain("Entry:");
    expect(text).toContain("67,000.00");
    expect(text).toContain("Now:");
    expect(text).toContain("67,250.00");
  });
});
