import { formatTradeConfirmationMessage } from "../confirmationMessage";
import { ResolvedTrade, TradeSignal } from "../types";

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    raw: "BUY TAOUSDT@123 SL 122 TP1 124",
    action: "BUY",
    rawSymbol: "TAOUSDT",
    entry: 123,
    sl: 122,
    tp: [124],
    orderType: "market",
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
    allTpTargets: [124],
    equity: 10000,
    riskPercent: 0.01,
    riskAmount: 100,
    minVol: 1,
    volScale: 0,
    volUnit: 1,
    currentPrice: 123,
    contractSize: 1,
    takerFeeRate: 0.0006,
    makerFeeRate: 0.0002,
    ...overrides,
  };
}

describe("formatTradeConfirmationMessage", () => {
  it("shows expected TP and SL with net PNL including fees", () => {
    const text = formatTradeConfirmationMessage(makeTrade(), "USDT");

    expect(text).toContain("TRADE CONFIRMATION");
    expect(text).toContain("TAO_USDT</b> · LONG · 50x · Isolated");
    expect(text).toContain("Market entry @ 123.00");
    expect(text).toContain("Expected TP: <b>124.00</b>");
    expect(text).toContain("Expected SL: <b>122.00</b>");
    // Risk and notional
    expect(text).toContain("Risk: 100.00 USDT (1.0%) · Notional: ~5,043.00 USDT");
  });

  it("reports net TP profit net of entry+exit fees", () => {
    const text = formatTradeConfirmationMessage(makeTrade(), "USDT");

    // Gross TP = 41 × (124 − 123) = 41
    // Entry fee = 41×123×0.0006 = 3.0258; exit fee = 41×124×0.0006 = 3.0504
    // Net = 41 − 6.0762 = 34.9238 ≈ +34.92; margin = 41×123/50 = 100.86 → 34.6%
    expect(text).toContain("Est. net profit: <b>+34.92</b> USDT (34.6%) · incl. fees");
    expect(text).toContain("Est. fees: 6.08 USDT (3.03 entry + 3.05 exit)");
  });

  it("reports net SL loss including fees", () => {
    const text = formatTradeConfirmationMessage(makeTrade(), "USDT");

    // Gross SL = 41 × (123 − 122) = 41
    // Exit fee at SL = 41×122×0.0006 = 3.0012; total fees = 6.027
    // Net = −41 − 6.027 = −47.027 ≈ −47.03; margin 100.86 → −46.6%
    expect(text).toContain("Est. net loss: <b>-47.03</b> USDT (-46.6%) · incl. fees");
  });

  it("uses maker fees for TP/SL exits when limit TP/SL is active", () => {
    const text = formatTradeConfirmationMessage(
      makeTrade(),
      "USDT",
      { useLimitTpSl: true }
    );

    // Exit fee = 41×124×0.0002 = 1.0168; total = 4.0426
    // Net TP = 41 − 4.0426 = 36.9574 ≈ +36.96
    expect(text).toContain("Est. net profit: <b>+36.96</b> USDT (36.6%) · incl. fees");
    expect(text).toContain("Est. fees: 4.04 USDT (3.03 entry + 1.02 exit)");
  });

  it("falls back to gross (before-fee) figures when fee rates are unknown", () => {
    const text = formatTradeConfirmationMessage(
      makeTrade({ takerFeeRate: undefined, makerFeeRate: undefined }),
      "USDT"
    );

    expect(text).toContain("Est. profit: ~41.00 USDT (40.7%) · before fees");
    expect(text).toContain("Est. loss: ~-41.00 USDT (-40.7%) · before fees");
    expect(text).not.toContain("Est. fees:");
    expect(text).not.toContain("incl. fees");
  });

  it("formats a short position", () => {
    const text = formatTradeConfirmationMessage(
      makeTrade({
        signal: makeSignal({ action: "SELL" }),
        side: 3,
        stopLossPrice: 124,
        takeProfitPrice: 122,
        allTpTargets: [122],
      }),
      "USDT"
    );

    expect(text).toContain("TAO_USDT</b> · SHORT · 50x · Isolated");
    // Gross TP = 41 × (123 − 122) = 41; exit fee at 122 = 3.0012; total 6.027
    // Net = 41 − 6.027 = 34.973 ≈ +34.97
    expect(text).toContain("Est. net profit: <b>+34.97</b> USDT (34.7%) · incl. fees");
    // Gross SL = 41; exit fee at 124 = 3.0504; total 6.0762 → net −47.08
    expect(text).toContain("Est. net loss: <b>-47.08</b> USDT (-46.7%) · incl. fees");
  });

  it("labels a trigger entry and uses maker entry fees", () => {
    const text = formatTradeConfirmationMessage(
      makeTrade({ signal: makeSignal({ orderType: "trigger" }) }),
      "USDT"
    );

    expect(text).toContain("Trigger entry @ 123.00");
    // Entry fee (maker) = 41×123×0.0002 = 1.0086; exit (taker) = 3.0504
    // Total = 4.059; Net TP = 41 − 4.059 = 36.941 ≈ +36.94
    expect(text).toContain("Est. net profit: <b>+36.94</b> USDT (36.6%) · incl. fees");
  });

  it("adds a dry-run marker when configured", () => {
    const text = formatTradeConfirmationMessage(makeTrade(), "USDT", { dryRun: true });
    expect(text).toContain("TRADE CONFIRMATION</b> · 🧪 DRY RUN");
  });

  it("shows the pending queue size and awaiting-confirmation footer", () => {
    const text = formatTradeConfirmationMessage(makeTrade(), "USDT", {
      pendingCount: 3,
    });

    expect(text).toContain("📋 Queue: 3 order(s) pending — send CONFIRM ORDERS to place");
    expect(text).toContain("⏳ Queued — awaiting <b>CONFIRM ORDERS</b>");
  });
});
