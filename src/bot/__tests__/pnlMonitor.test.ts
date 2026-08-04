import { PositionClosureMonitor } from "../pnlMonitor";
import { AccountSnapshot, ClosedPositionInfo } from "../pnlMonitor";
import { Logger } from "../../utils/logger";
import { Position } from "../../types/account";

const logger = new Logger({ level: "SILENT" });

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: 1,
    symbol: "BTC_USDT",
    positionType: 1, // long
    openType: 1, // isolated
    state: 1, // holding
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
    ...overrides,
  };
}

describe("PositionClosureMonitor", () => {
  let client: any;
  let onClose: jest.Mock;

  beforeEach(() => {
    onClose = jest.fn();
    client = {
      getOpenPositions: jest.fn(),
      getPositionHistory: jest.fn(),
      getAccountAsset: jest.fn(),
    };
  });

  it("seeds on the first poll and does not notify", async () => {
    client.getOpenPositions.mockResolvedValue({ data: [makePosition()] });

    const monitor = new PositionClosureMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      intervalSeconds: 30,
      onClose,
    });

    await monitor.poll();

    expect(client.getOpenPositions).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("detects a closed position and reports realized PNL + account snapshot", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition()] }) // seed
      .mockResolvedValue({ data: [] }); // closure detected
    client.getPositionHistory.mockResolvedValue({
      data: [
        makePosition({
          state: 3,
          holdVol: 0,
          closeVol: 1,
          closeAvgPrice: 69000,
          realised: 176.7,
          updateTime: 3000,
        }),
      ],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1234.56, equity: 5678.9 },
    });

    const monitor = new PositionClosureMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      intervalSeconds: 30,
      onClose,
    });

    await monitor.poll(); // seed
    await monitor.poll(); // detect closure

    expect(onClose).toHaveBeenCalledTimes(1);

    const [info, account] = onClose.mock.calls[0] as [
      ClosedPositionInfo,
      AccountSnapshot
    ];
    expect(info.positionId).toBe("1");
    expect(info.symbol).toBe("BTC_USDT");
    expect(info.positionType).toBe(1);
    expect(info.leverage).toBe(10);
    expect(info.openAvgPrice).toBe(67000);
    expect(info.closeAvgPrice).toBe(69000);
    expect(info.realisedPnl).toBe(176.7);
    // PNL % relative to initial margin (oim=100): 176.7 / 100 * 100
    expect(info.pnlPercent).toBeCloseTo(176.7, 5);
    expect(info.closeTime).toBe(3000);
    expect(account.availableBalance).toBe(1234.56);
    expect(account.equity).toBe(5678.9);
  });

  it("does not notify again once a closure has been handled", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition()] }) // seed
      .mockResolvedValue({ data: [] }); // closure (subsequent polls find nothing new)
    client.getPositionHistory.mockResolvedValue({
      data: [makePosition({ state: 3, holdVol: 0, closeVol: 1, realised: 5 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1, equity: 2 },
    });

    const monitor = new PositionClosureMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      intervalSeconds: 30,
      onClose,
    });

    await monitor.poll(); // seed
    await monitor.poll(); // detect + notify once
    await monitor.poll(); // nothing left

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last-known position data when history is unavailable", async () => {
    jest.useFakeTimers();
    try {
      client.getOpenPositions
        .mockResolvedValueOnce({ data: [makePosition()] }) // seed
        .mockResolvedValue({ data: [] }); // closure detected
      client.getPositionHistory.mockResolvedValue({ data: [] });
      client.getAccountAsset.mockResolvedValue({
        data: { availableBalance: 10, equity: 20 },
      });

      const monitor = new PositionClosureMonitor({
        client,
        logger,
        baseCurrency: "USDT",
        intervalSeconds: 30,
        onClose,
      });

      const seed = monitor.poll();
      await seed;

      const close = monitor.poll();
      // 5 history attempts with 1s/2s/3s/4s backoffs — advance past all of them
      await jest.advanceTimersByTimeAsync(15000);
      await close;

      expect(onClose).toHaveBeenCalledTimes(1);
      const [info] = onClose.mock.calls[0] as [ClosedPositionInfo];
      expect(info.symbol).toBe("BTC_USDT");
      expect(info.realisedPnl).toBe(0); // from last-known snapshot
    } finally {
      jest.useRealTimers();
    }
  });
});
