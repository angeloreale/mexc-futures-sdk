import { formatOrderPlacedMessage } from "../orderMessage";
import { TradeRecord, ResolvedTrade, TradeSignal } from "../types";

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    raw: "BUY TAOUSDT@123 SL 122 TP1 124 TP2 125 L50",
    action: "BUY",
    rawSymbol: "TAOUSDT",
    entry: 123,
    sl: 122,
    tp: [124, 125],
    orderType: "trigger",
    leverageOverride: 50,
    ...overrides,
  };
}

function makeTrade(overrides?: Partial<ResolvedTrade>): ResolvedTrade {
  return {
    signal: makeSignal(),
    mexcSymbol: "TAO_USDT",
    volume: 41,
    side: 1,
    leverage: 50,
    openType: 1,
    entry: 123,
    stopLossPrice: 122,
    takeProfitPrice: 124,
    allTpTargets: [124, 125],
    equity: 10000,
    riskPercent: 0.01,
    riskAmount: 100,
    minVol: 1,
    volScale: 0,
    volUnit: 1,
    currentPrice: 123,
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    resolved: makeTrade(),
    orderId: "817027833053397504",
    success: true,
    executedAt: Date.now(),
    ...overrides,
  };
}

describe("formatOrderPlacedMessage", () => {
  it("formats a pending trigger order placement", () => {
    const text = formatOrderPlacedMessage(makeRecord(), "USDT");

    expect(text).toContain("ORDER PLACED");
    expect(text).toContain("TAO_USDT</b> · LONG · 50x · Isolated");
    expect(text).toContain("Pending trigger @ 123.00");
    expect(text).toContain("SL: 122.00 · TP: 124.00, 125.00");
    expect(text).toContain("Vol: 41.00 · Notional: ~5,043.00 USDT");
    expect(text).toContain("Risk: 100.00 USDT (1.0%)");
    expect(text).toContain("Order ID: <code>817027833053397504</code>");
  });

  it("formats a market order that fills immediately", () => {
    const text = formatOrderPlacedMessage(
      makeRecord({
        resolved: makeTrade({ signal: makeSignal({ orderType: "market" }) }),
      }),
      "USDT"
    );

    expect(text).toContain("Market entry @ 123.00");
    expect(text).not.toContain("Pending trigger");
  });

  it("formats a short cross-margin order", () => {
    const text = formatOrderPlacedMessage(
      makeRecord({
        resolved: makeTrade({
          signal: makeSignal({ action: "SELL", orderType: "market" }),
          side: 3,
          openType: 2,
        }),
      }),
      "USDT"
    );

    expect(text).toContain("TAO_USDT</b> · SHORT · 50x · Cross");
  });
});
