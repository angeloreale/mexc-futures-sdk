import { formatPositionClosedMessage } from "../pnlMessage";
import {
  AccountSnapshot,
  ClosedPositionInfo,
} from "../pnlMonitor";

function makeInfo(overrides?: Partial<ClosedPositionInfo>): ClosedPositionInfo {
  return {
    positionId: "12345",
    symbol: "BTC_USDT",
    positionType: 1, // long
    openType: 1, // isolated
    leverage: 10,
    openAvgPrice: 67000,
    closeAvgPrice: 69000,
    holdVol: 1,
    realisedPnl: 176.7,
    pnlPercent: 5.12,
    margin: 3450,
    createTime: 0,
    closeTime: 0,
    ...overrides,
  };
}

function makeAccount(overrides?: Partial<AccountSnapshot>): AccountSnapshot {
  return {
    availableBalance: 1234.56,
    equity: 5678.9,
    currency: "USDT",
    ...overrides,
  };
}

describe("formatPositionClosedMessage", () => {
  it("formats a profitable long close with PNL, balance and equity", () => {
    const text = formatPositionClosedMessage(makeInfo(), makeAccount());

    expect(text).toContain("POSITION CLOSED");
    expect(text).toContain("BTC_USDT");
    expect(text).toContain("LONG");
    expect(text).toContain("10x");
    expect(text).toContain("Realized PNL: +176.70 USDT (+5.12%)");
    expect(text).toContain("Available: 1,234.56 USDT");
    expect(text).toContain("Equity: 5,678.90 USDT");
  });

  it("formats a losing short close with negative signs", () => {
    const text = formatPositionClosedMessage(
      makeInfo({ positionType: 2, realisedPnl: -3.2, pnlPercent: -0.5 }),
      makeAccount()
    );

    expect(text).toContain("SHORT");
    expect(text).toContain("Realized PNL: -3.20 USDT (-0.50%)");
  });

  it("handles zero PNL without a sign", () => {
    const text = formatPositionClosedMessage(
      makeInfo({ realisedPnl: 0, pnlPercent: 0 }),
      makeAccount()
    );

    expect(text).toContain("Realized PNL: 0.00 USDT (0.00%)");
  });

  it("shows a dash when balance data is unavailable", () => {
    const text = formatPositionClosedMessage(
      makeInfo(),
      makeAccount({ availableBalance: NaN, equity: NaN })
    );

    expect(text).toContain("Available: — USDT");
    expect(text).toContain("Equity: — USDT");
  });
});
