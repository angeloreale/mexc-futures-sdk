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
    expect(text).toContain("SL: 122.00 · TP: 124.00");
    expect(text).toContain("Vol: 41.00 · Notional: ~5,043.00 USDT");
    expect(text).toContain("Risk: 100.00 USDT (1.0%)");
    expect(text).toContain("Est. profit @ TP 124.00: ~41.00 USDT (40.7%)");
    expect(text).toContain("Order ID: <code>817027833053397504</code>");
    expect(text).not.toContain("125.00");
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

  it("estimates profit for a short at the first TP target", () => {
    const text = formatOrderPlacedMessage(
      makeRecord({
        resolved: makeTrade({
          signal: makeSignal({ action: "SELL", orderType: "market" }),
          side: 3,
          entry: 123,
          stopLossPrice: 124,
          takeProfitPrice: 122,
          allTpTargets: [122, 121],
        }),
      }),
      "USDT"
    );

    // volume 41 × (entry 123 − TP 122) = 41.00 USDT; margin 41×123/50
    expect(text).toContain("Est. profit @ TP 122.00: ~41.00 USDT (40.7%)");
  });

  it("shows only its own TP/volume/risk for each split order", () => {
    // Signal with 2 TPs split into 2 orders of 20 contracts each.
    const base = makeTrade({ volume: 40, riskAmount: 100 });

    const first = formatOrderPlacedMessage(
      makeRecord({ resolved: base, orderVolume: 20, orderTp: 124, orderId: "111" }),
      "USDT"
    );
    const second = formatOrderPlacedMessage(
      makeRecord({ resolved: base, orderVolume: 20, orderTp: 125, orderId: "222" }),
      "USDT"
    );

    // First order: only TP 124, half the volume/notional/risk, its own profit.
    expect(first).toContain("SL: 122.00 · TP: 124.00");
    expect(first).toContain("Vol: 20.00 · Notional: ~2,460.00 USDT");
    expect(first).toContain("Risk: 50.00 USDT (1.0%)");
    expect(first).toContain("Est. profit @ TP 124.00: ~20.00 USDT (40.7%)");
    expect(first).not.toContain("125.00");

    // Second order: only TP 125, half the volume/notional/risk, its own profit.
    expect(second).toContain("SL: 122.00 · TP: 125.00");
    expect(second).toContain("Vol: 20.00 · Notional: ~2,460.00 USDT");
    expect(second).toContain("Risk: 50.00 USDT (1.0%)");
    expect(second).toContain("Est. profit @ TP 125.00: ~40.00 USDT (81.3%)");
    expect(second).not.toContain("124.00");
  });
});
