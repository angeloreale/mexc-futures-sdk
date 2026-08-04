import { PositionSummaryMonitor, PositionSummary } from "../summaryMonitor";
import { Logger } from "../../utils/logger";
import { Position } from "../../types/account";

const logger = new Logger({ level: "SILENT" });

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: 1,
    symbol: "BTC_USDT",
    positionType: 1,
    openType: 1,
    state: 1,
    holdVol: 1,
    frozenVol: 0,
    closeVol: 0,
    holdAvgPrice: 0,
    openAvgPrice: 67000,
    closeAvgPrice: 0,
    liquidatePrice: 0,
    oim: 100,
    im: 100,
    holdFee: 0,
    realised: 0,
    leverage: 10,
    createTime: 1000,
    updateTime: 2000,
    unRealizedPnl: 0,
    ...overrides,
  };
}

describe("PositionSummaryMonitor", () => {
  let client: any;
  let onSummary: jest.Mock;

  beforeEach(() => {
    onSummary = jest.fn();
    client = {
      getOpenPositions: jest.fn(),
      getAccountAsset: jest.fn(),
    };
  });

  it("tracks current / max / min PNL across samples", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 10 })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 25 })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 5 })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 12 })] }); // emitSummary fetch

    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });

    const monitor = new PositionSummaryMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      sampleIntervalSeconds: 30,
      windowHours: 4,
      intervalHours: 8,
      onSummary,
    });

    await monitor.sample(); // pnl 10
    await monitor.sample(); // pnl 25
    await monitor.sample(); // pnl 5
    await monitor.emitSummary();

    expect(onSummary).toHaveBeenCalledTimes(1);
    const summary: PositionSummary = onSummary.mock.calls[0][0];
    expect(summary.windowHours).toBe(4);
    expect(summary.intervalHours).toBe(8);
    expect(summary.openPositions).toHaveLength(1);

    const pos = summary.openPositions[0];
    expect(pos.symbol).toBe("BTC_USDT");
    expect(pos.positionType).toBe(1);
    expect(pos.leverage).toBe(10);
    expect(pos.currentPnl).toBe(12); // freshest fetch value
    expect(pos.maxPnl).toBe(25); // highest sampled in window
    expect(pos.minPnl).toBe(5); // lowest sampled in window
  });

  it("includes the account snapshot in the summary", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 3 })] })
      .mockResolvedValue({ data: [makePosition({ unRealizedPnl: 3 })] });

    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1234.56, equity: 5678.9 },
    });

    const monitor = new PositionSummaryMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      sampleIntervalSeconds: 30,
      windowHours: 4,
      intervalHours: 8,
      onSummary,
    });

    await monitor.sample();
    await monitor.emitSummary();

    const summary: PositionSummary = onSummary.mock.calls[0][0];
    expect(summary.openPositions).toHaveLength(1);
    expect(summary.openPositions[0].symbol).toBe("BTC_USDT");
    expect(summary.account.availableBalance).toBe(1234.56);
    expect(summary.account.equity).toBe(5678.9);
  });

  it("drops positions that have closed from tracked stats", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 10 })] })
      .mockResolvedValueOnce({ data: [] }) // closed
      .mockResolvedValue({ data: [makePosition({ positionId: 2, symbol: "ETH_USDT", unRealizedPnl: -4 })] });

    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1, equity: 2 },
    });

    const monitor = new PositionSummaryMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      sampleIntervalSeconds: 30,
      windowHours: 4,
      intervalHours: 8,
      onSummary,
    });

    await monitor.sample(); // track position 1
    await monitor.sample(); // position 1 gone → should be dropped
    await monitor.emitSummary(); // fresh fetch shows only position 2

    const summary: PositionSummary = onSummary.mock.calls[0][0];
    expect(summary.openPositions).toHaveLength(1);
    expect(summary.openPositions[0].positionId).toBe("2");
    expect(summary.openPositions[0].symbol).toBe("ETH_USDT");
    // position 1 stats were dropped, so no stale max/min carry over
    expect(summary.openPositions[0].maxPnl).toBe(-4);
    expect(summary.openPositions[0].minPnl).toBe(-4);
  });
});
