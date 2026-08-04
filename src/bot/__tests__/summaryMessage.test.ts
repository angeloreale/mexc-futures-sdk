import { formatPositionSummaryMessage } from "../summaryMessage";
import { PositionSummary } from "../summaryMonitor";

function makeSummary(overrides?: Partial<PositionSummary>): PositionSummary {
  return {
    windowHours: 4,
    intervalHours: 8,
    generatedAt: 0,
    openPositions: [
      {
        positionId: "1",
        symbol: "BTC_USDT",
        positionType: 1,
        openType: 1,
        leverage: 10,
        openAvgPrice: 67000,
        currentPnl: 176.7,
        maxPnl: 210.1,
        minPnl: -5.3,
        margin: 3450,
      },
      {
        positionId: "2",
        symbol: "ETH_USDT",
        positionType: 2,
        openType: 1,
        leverage: 5,
        openAvgPrice: 3500,
        currentPnl: -12.0,
        maxPnl: 40.5,
        minPnl: -15.2,
        margin: 700,
      },
    ],
    account: {
      availableBalance: 1234.56,
      equity: 5678.9,
      currency: "USDT",
    },
    ...overrides,
  };
}

describe("formatPositionSummaryMessage", () => {
  it("includes header, open positions and account", () => {
    const text = formatPositionSummaryMessage(makeSummary());

    expect(text).toContain("POSITION SUMMARY");
    expect(text).toContain("Last 4h · report every 8h");
    expect(text).toContain("Open Positions (2)");
    expect(text).toContain("BTC_USDT</b> LONG · 10x");
    expect(text).toContain("PNL: <b>+176.70 USDT</b>");
    expect(text).toContain("max +210.10 / min -5.30 USDT");
    expect(text).toContain("ETH_USDT</b> SHORT · 5x");
    expect(text).toContain("PNL: <b>-12.00 USDT</b>");
    expect(text).not.toContain("Pending Triggers");
    expect(text).toContain("Available: 1,234.56 USDT");
    expect(text).toContain("Equity: 5,678.90 USDT");
  });

  it("handles an empty account gracefully", () => {
    const text = formatPositionSummaryMessage(
      makeSummary({
        openPositions: [],
        account: { availableBalance: NaN, equity: NaN, currency: "USDT" },
      })
    );

    expect(text).toContain("Open Positions (0)");
    expect(text).toContain("No open positions");
    expect(text).toContain("Available: — USDT");
    expect(text).toContain("Equity: — USDT");
  });
});
