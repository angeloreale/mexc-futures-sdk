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
        holdVol: 1,
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
        holdVol: 1,
      },
    ],
    account: {
      availableBalance: 1234.56,
      equity: 5678.9,
      currency: "USDT",
    },
    dailyPnl: {
      date: "2026-08-06",
      realized: 15.2,
      unrealized: 3.4,
      total: 18.6,
      prevDate: "2026-08-05",
      tick: 4.1,
    },
    pendingOrders: [],
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
    expect(text).toContain("🆔 <code>CLOSE 1</code>");
    expect(text).toContain("🆔 <code>CLOSE 2</code>");
    expect(text).toContain("PNL: <b>+176.70 USDT</b>");
    expect(text).toContain("max +210.10 / min -5.30 USDT");
    expect(text).toContain("ETH_USDT</b> SHORT · 5x");
    expect(text).toContain("PNL: <b>-12.00 USDT</b>");
    expect(text).toContain("Pending Orders (0)");
    expect(text).toContain("No pending orders");
    expect(text).toContain("Available: 1,234.56 USDT");
    expect(text).toContain("Equity: 5,678.90 USDT");
  });

  it("shows daily realized + unrealized PNL and the tick vs the previous day", () => {
    const text = formatPositionSummaryMessage(makeSummary());

    expect(text).toContain("Daily PNL</b> · 2026-08-06");
    expect(text).toContain("Realized: <b>+15.20</b> USDT");
    expect(text).toContain("Unrealized: <b>+3.40</b> USDT");
    expect(text).toContain("Total: <b>+18.60</b> USDT · tick <b>+4.10</b> vs 2026-08-05");
  });

  it("hides the daily PNL tick when there is no previous-day data", () => {
    const text = formatPositionSummaryMessage(
      makeSummary({
        dailyPnl: {
          date: "2026-08-06",
          realized: -2.5,
          unrealized: 1.1,
          total: -1.4,
          tick: null,
        },
      })
    );

    expect(text).toContain("Realized: <b>-2.50</b> USDT");
    expect(text).toContain("Unrealized: <b>+1.10</b> USDT");
    expect(text).toContain("Total: <b>-1.40</b> USDT");
    expect(text).not.toContain("tick");
  });

  it("renders pending STOP entries and TP/SL pairs as single lines", () => {
    const text = formatPositionSummaryMessage(
      makeSummary({
        pendingOrders: [
          {
            orderId: "817027833053397504",
            symbol: "TAO_USDT",
            side: 1,
            kind: "STOP",
            triggerType: 1,
            triggerPrice: 187.54,
            takeProfitPrice: NaN,
            stopLossPrice: NaN,
            positionType: 1,
            vol: 0.5,
            leverage: 10,
            openType: 1,
          },
          {
            orderId: "88",
            symbol: "XLM_USDT",
            side: 4,
            kind: "TP_SL",
            triggerType: 1,
            triggerPrice: NaN,
            takeProfitPrice: 0.1788,
            stopLossPrice: 0.1677,
            positionType: 1, // long: TP ≥, SL ≤
            vol: 110,
            leverage: 0,
            openType: 1,
          },
          {
            orderId: "99",
            symbol: "ETH_USDT",
            side: 2,
            kind: "TP_SL",
            triggerType: 1,
            triggerPrice: NaN,
            takeProfitPrice: 1856,
            stopLossPrice: 1884.95,
            positionType: 2, // short: TP ≤, SL ≥
            vol: 0.17,
            leverage: 0,
            openType: 1,
          },
        ],
      })
    );

    expect(text).toContain("Pending Orders (3)");
    expect(text).toContain("🟡 TAO_USDT LONG · STOP ≥187.54 · 0.50 · <code>…397504</code>");
    expect(text).toContain("🟡 XLM_USDT LONG · TP ≥0.18 / SL ≤0.17 · 110.00 · <code>88</code>");
    expect(text).toContain("🟡 ETH_USDT SHORT · TP ≤1,856.00 / SL ≥1,884.95 · 0.17 · <code>99</code>");
  });

  it("shows % of TP for winning positions and % of SL for losing ones", () => {
    const text = formatPositionSummaryMessage(
      makeSummary({
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
            holdVol: 1,
            estTpPnl: 1039.41,
            estSlPnl: -566.0,
            tpProgress: 0.17,
            slProgress: -0.31,
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
            holdVol: 1,
            estTpPnl: 53.2,
            estSlPnl: -50.0,
            tpProgress: -0.23,
            slProgress: 0.24,
          },
        ],
      })
    );

    // Winner → positive % of TP.
    expect(text).toContain("🎯 Est TP <b>+1,039.41</b> / SL <b>-566.00</b> USDT · <b>+17%</b> of TP");
    // Loser → positive % of SL (previously showed a negative % of TP).
    expect(text).toContain("🎯 Est TP <b>+53.20</b> / SL <b>-50.00</b> USDT · <b>24%</b> of SL");
    expect(text).not.toContain("-23% of TP");
  });

  it("omits the progress line when TP/SL progress is unavailable", () => {
    const text = formatPositionSummaryMessage(
      makeSummary({
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
            holdVol: 1,
            estTpPnl: 1039.41,
            estSlPnl: -566.0,
            // no tpProgress / slProgress
          },
        ],
      })
    );

    expect(text).toContain("🎯 Est TP <b>+1,039.41</b> / SL <b>-566.00</b> USDT");
    expect(text).not.toContain("of TP");
    expect(text).not.toContain("of SL");
  });

  it("handles an empty account gracefully", () => {
    const text = formatPositionSummaryMessage(
      makeSummary({
        openPositions: [],
        pendingOrders: [],
        account: { availableBalance: NaN, equity: NaN, currency: "USDT" },
      })
    );

    expect(text).toContain("Open Positions (0)");
    expect(text).toContain("No open positions");
    expect(text).toContain("Available: — USDT");
    expect(text).toContain("Equity: — USDT");
  });
});
