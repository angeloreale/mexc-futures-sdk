import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PositionSummaryMonitor,
  PositionSummary,
  PositionAlert,
} from "../summaryMonitor";
import { Logger } from "../../utils/logger";
import { Position } from "../../types/account";
import { SlTpStore } from "../slTpStore";

const logger = new Logger({ level: "SILENT" });

let statsFileCounter = 0;
function tempStatsFile(): string {
  statsFileCounter += 1;
  return path.join(
    os.tmpdir(),
    `mexc-summary-stats-${process.pid}-${Date.now()}-${statsFileCounter}.json`
  );
}

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

function makeMonitor(
  client: any,
  store: SlTpStore,
  onSummary: jest.Mock,
  onAlert: jest.Mock,
  opts: Partial<ConstructorParameters<typeof PositionSummaryMonitor>[0]> = {}
) {
  return new PositionSummaryMonitor({
    client,
    logger,
    baseCurrency: "USDT",
    sampleIntervalSeconds: 30,
    windowHours: 4,
    intervalHours: 8,
    onSummary,
    slTpStore: store,
    onAlert,
    slTpRetentionDays: 90,
    ...opts,
  });
}

describe("PositionSummaryMonitor", () => {
  let client: any;
  let onSummary: jest.Mock;
  let onAlert: jest.Mock;
  let store: SlTpStore;

  beforeEach(() => {
    onSummary = jest.fn();
    onAlert = jest.fn();
    store = new SlTpStore();
    client = {
      getOpenPositions: jest.fn(),
      getAccountAsset: jest.fn(),
      getPlanOrders: jest.fn().mockResolvedValue({ data: [] }),
      getStopOrders: jest.fn().mockResolvedValue({ data: [] }),
      getPositionHistory: jest.fn().mockResolvedValue({ data: [] }),
      getContractDetail: jest
        .fn()
        .mockImplementation(async (symbol: string) => ({ data: [{ symbol, contractSize: 1 }] })),
    };
  });

  it("tracks current / max / min PNL across samples", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 10 })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 25 })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 5 })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 12 })] });

    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);

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

  it("coerces string-valued unRealizedPnl into numbers for min/max tracking", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: "10" as any })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: "20" as any })] })
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: "15" as any })] });

    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: "1234.56", equity: 5000 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();
    await monitor.sample();
    await monitor.emitSummary();

    const summary: PositionSummary = onSummary.mock.calls[0][0];
    expect(summary.openPositions[0].currentPnl).toBe(15);
    expect(summary.openPositions[0].maxPnl).toBe(20);
    expect(summary.openPositions[0].minPnl).toBe(10);
  });

  it("coerces string-valued availableBalance into a number", async () => {
    client.getOpenPositions.mockResolvedValue({ data: [makePosition({ unRealizedPnl: 1 })] });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: "1234.56", equity: 5000 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();
    await monitor.emitSummary();

    expect(onSummary.mock.calls[0][0].account.availableBalance).toBe(1234.56);
  });

  it("computes total PNL as floating PNL plus realized PNL", async () => {
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ unRealizedPnl: 176.7, realised: 15.2 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.emitSummary();

    const pos = onSummary.mock.calls[0][0].openPositions[0];
    expect(pos.currentPnl).toBe(176.7); // floating PNL
    expect(pos.realisedPnl).toBe(15.2); // realized PNL
    expect(pos.totalPnl).toBeCloseTo(191.9, 6); // floating + realized
  });

  // ── Alert tests ─────────────────────────────────────────────────────

  it("fires SL alert when LONG position is >50% toward SL", async () => {
    // Entry 100, holdVol 10, currentPrice = 87 → PNL = (87-100)*10 = -130
    // SL = 80, dist entry→SL = 20, progress = (100-87)/20 = 0.65
    store.set("BTC_USDT", { sl: 80, tp: 130, positionType: 1, setAt: Date.now() });

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: -130, positionType: 1 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();

    expect(onAlert).toHaveBeenCalledTimes(1);
    const a: PositionAlert = onAlert.mock.calls[0][0];
    expect(a.target).toBe("SL");
    expect(a.symbol).toBe("BTC_USDT");
    expect(a.progress).toBeCloseTo(0.65, 2);
  });

  it("fires TP alert when LONG position is >50% toward TP", async () => {
    // Entry 100, holdVol 10, currentPrice = 116 → PNL = 160
    // TP = 120, dist = 20, progress = 16/20 = 0.8
    store.set("BTC_USDT", { sl: 80, tp: 120, positionType: 1, setAt: Date.now() });

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: 160, positionType: 1 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();

    expect(onAlert).toHaveBeenCalledTimes(1);
    const a: PositionAlert = onAlert.mock.calls[0][0];
    expect(a.target).toBe("TP");
    expect(a.progress).toBeCloseTo(0.8, 2);
  });

  it("does not fire alert when under 50% threshold", async () => {
    store.set("BTC_USDT", { sl: 80, tp: 120, positionType: 1, setAt: Date.now() });

    // Price at 109 → PNL = 90, progress to TP = 9/20 = 0.45 (<0.5), progress to SL negative
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: 90, positionType: 1 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();

    expect(onAlert).not.toHaveBeenCalled();
  });

  it("fires alert only once per target (dedup)", async () => {
    store.set("BTC_USDT", { sl: 80, tp: 130, positionType: 1, setAt: Date.now() });

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: -130, positionType: 1 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();
    expect(onAlert).toHaveBeenCalledTimes(1);

    await monitor.sample();
    // Still only 1 call — dedup prevented a second alert.
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it("clears alert flags when position closes, allowing re-alert on new position", async () => {
    store.set("BTC_USDT", { sl: 80, tp: 130, positionType: 1, setAt: Date.now() });

    // First: position 1 alerts.
    client.getOpenPositions.mockResolvedValueOnce({
      data: [makePosition({ positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: -130, positionType: 1 })],
    });
    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();
    expect(onAlert).toHaveBeenCalledTimes(1);

    // Position 1 closes, position 2 opens.
    client.getOpenPositions.mockResolvedValueOnce({
      data: [makePosition({ positionId: 2, openAvgPrice: 100, holdVol: 10, unRealizedPnl: -130, positionType: 1 })],
    });
    store.set("BTC_USDT", { sl: 80, tp: 130, positionType: 1, setAt: Date.now() });
    await monitor.sample();
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it("fires TP alert for SHORT position >50% toward TP", async () => {
    // Entry 100, holdVol 10, currentPrice = 88 → PNL = (100-88)*10 = 120
    // TP = 80, dist = 20, progress = (100-88)/20 = 0.6
    store.set("ETH_USDT", { sl: 115, tp: 80, positionType: 2, setAt: Date.now() });

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "ETH_USDT", positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: 120, positionType: 2 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();

    expect(onAlert).toHaveBeenCalledTimes(1);
    const a: PositionAlert = onAlert.mock.calls[0][0];
    expect(a.target).toBe("TP");
    expect(a.symbol).toBe("ETH_USDT");
    expect(a.progress).toBeCloseTo(0.6, 2);
  });

  it("fires SL alert for SHORT position >50% toward SL", async () => {
    // Entry 100, holdVol 10, currentPrice = 109 → PNL = -(109-100)*10 = -90
    // Hmm wait, for short: unRealizedPnl = (entry - currentPrice)*holdVol = (100-109)*10 = -90
    // SL = 115, dist = 15, progress = (109-100)/15 = 0.6
    store.set("ETH_USDT", { sl: 115, tp: 80, positionType: 2, setAt: Date.now() });

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "ETH_USDT", positionId: 1, openAvgPrice: 100, holdVol: 10, unRealizedPnl: -90, positionType: 2 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();

    expect(onAlert).toHaveBeenCalledTimes(1);
    const a: PositionAlert = onAlert.mock.calls[0][0];
    expect(a.target).toBe("SL");
    expect(a.symbol).toBe("ETH_USDT");
    expect(a.progress).toBeCloseTo(0.6, 2);
  });

  it("uses contract size when deriving price for alerts (ATOM cs=0.1)", async () => {
    // ATOM_USDT contractSize = 0.1. Entry 1.35, holdVol 244, TP 1.37.
    // Real price 1.361 → progress = (1.361-1.35)/(1.37-1.35) = 0.55 → alert.
    // PNL = (1.361-1.35) * 244 * 0.1 = 0.2684.
    // (Without the contract-size fix, derived price = 1.35 + 0.2684/244 ≈ 1.351
    //  → progress 0.05 → NO alert.)
    store.set("ATOM_USDT", { sl: 1.33, tp: 1.37, positionType: 1, setAt: Date.now() });
    client.getContractDetail = jest
      .fn()
      .mockResolvedValue({ data: [{ symbol: "ATOM_USDT", contractSize: 0.1 }] });
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "ATOM_USDT", positionId: 1, openAvgPrice: 1.35, holdVol: 244, unRealizedPnl: 0.2684, positionType: 1 })],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();

    expect(onAlert).toHaveBeenCalledTimes(1);
    const a: PositionAlert = onAlert.mock.calls[0][0];
    expect(a.target).toBe("TP");
    expect(a.symbol).toBe("ATOM_USDT");
    expect(a.progress).toBeCloseTo(0.55, 2);
  });

  it("attaches estimated TP/SL P&L and % toward TP to the summary", async () => {
    // ATOM LONG: entry 1.35, holdVol 244, cs 0.1, TP 1.37, SL 1.33.
    // estTpPnl = (1.37-1.35)*244*0.1 = 0.488; estSlPnl = (1.33-1.35)*244*0.1 = -0.488
    // PNL 0.2684 → tpProgress = 0.2684/0.488 ≈ 0.55
    store.set("ATOM_USDT", 1, { sl: 1.33, tp: 1.37, setAt: Date.now() });
    client.getContractDetail = jest
      .fn()
      .mockResolvedValue({ data: [{ symbol: "ATOM_USDT", contractSize: 0.1 }] });
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "ATOM_USDT", positionId: 1, openAvgPrice: 1.35, holdVol: 244, unRealizedPnl: 0.2684, positionType: 1 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.emitSummary();

    const pos = onSummary.mock.calls[0][0].openPositions[0];
    expect(pos.estTpPnl).toBeCloseTo(0.488, 6);
    expect(pos.estSlPnl).toBeCloseTo(-0.488, 6);
    expect(pos.tpProgress).toBeCloseTo(0.55, 2);
  });

  it("attaches slProgress for losing positions", async () => {
    // ATOM LONG: entry 1.35, holdVol 244, cs 0.1, TP 1.37, SL 1.33.
    // estTpPnl = 0.488; estSlPnl = -0.488.
    // Losing PNL -0.24 → slProgress = -0.24 / -0.488 ≈ 0.49
    store.set("ATOM_USDT", 1, { sl: 1.33, tp: 1.37, setAt: Date.now() });
    client.getContractDetail = jest
      .fn()
      .mockResolvedValue({ data: [{ symbol: "ATOM_USDT", contractSize: 0.1 }] });
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "ATOM_USDT", positionId: 1, openAvgPrice: 1.35, holdVol: 244, unRealizedPnl: -0.24, positionType: 1 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.emitSummary();

    const pos = onSummary.mock.calls[0][0].openPositions[0];
    expect(pos.estTpPnl).toBeCloseTo(0.488, 6);
    expect(pos.estSlPnl).toBeCloseTo(-0.488, 6);
    expect(pos.tpProgress).toBeCloseTo(-0.49, 2);
    expect(pos.slProgress).toBeCloseTo(0.49, 2);
  });

  it("computes daily PNL from realized history and open-position unrealized PNL", async () => {
    const now = Date.now();
    const yesterday = new Date(now - 86400_000).toISOString().slice(0, 10);

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "BTC_USDT", positionId: 1, unRealizedPnl: 5, positionType: 1 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });
    // One position closed today with +10 realized PNL.
    client.getPositionHistory.mockResolvedValue({
      data: [
        makePosition({ symbol: "BTC_USDT", positionId: 99, positionType: 1, realised: 10, updateTime: now }),
      ],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    // Seed yesterday's snapshot so the day-over-day tick can be exercised.
    (monitor as any).dailyPnlStore[yesterday] = {
      realized: 6,
      unrealized: 0,
      total: 6,
      updatedAt: now - 86400_000,
    };
    await monitor.emitSummary();

    const dp = onSummary.mock.calls[0][0].dailyPnl;
    expect(dp.realized).toBeCloseTo(10, 6);
    expect(dp.unrealized).toBeCloseTo(5, 6);
    expect(dp.total).toBeCloseTo(15, 6);
    expect(dp.prevDate).toBe(yesterday);
    expect(dp.tick).toBeCloseTo(9, 6); // 15 − 6
  });

  it("ignores pre-today history and reports no tick when no prior day exists", async () => {
    const now = Date.now();
    const todayStart = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    );

    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ symbol: "BTC_USDT", positionId: 1, unRealizedPnl: -3, positionType: 1 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1000, equity: 5000 },
    });
    // A close from yesterday must NOT count toward today's realized PNL.
    client.getPositionHistory.mockResolvedValue({
      data: [
        makePosition({ symbol: "BTC_USDT", positionId: 99, positionType: 1, realised: 10, updateTime: todayStart - 3600_000 }),
      ],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.emitSummary();

    const dp = onSummary.mock.calls[0][0].dailyPnl;
    expect(dp.realized).toBeCloseTo(0, 6);
    expect(dp.unrealized).toBeCloseTo(-3, 6);
    expect(dp.total).toBeCloseTo(-3, 6);
    expect(dp.tick).toBeNull();
  });

  // ── SlTpStore prune test ────────────────────────────────────────────

  it("prunes stale SlTpStore entries on sample", async () => {
    // Set a stale entry (2 days old) and keep retention at 1 day (86400000 ms)
    store.set("OLD_BTC", { sl: 80, tp: 130, positionType: 1, setAt: Date.now() - 2 * 86400000 });

    client.getOpenPositions.mockResolvedValue({ data: [] });

    const monitor = new PositionSummaryMonitor({
      client,
      logger,
      baseCurrency: "USDT",
      sampleIntervalSeconds: 30,
      windowHours: 4,
      intervalHours: 8,
      onSummary,
      slTpStore: store,
      onAlert,
      slTpRetentionDays: 1,
    });

    expect(store.get("OLD_BTC")).toBeDefined();
    await monitor.sample();
    expect(store.get("OLD_BTC")).toBeUndefined(); // pruned
  });

  it("includes the account snapshot in the summary", async () => {
    client.getOpenPositions
      .mockResolvedValueOnce({ data: [makePosition({ unRealizedPnl: 3 })] })
      .mockResolvedValue({ data: [makePosition({ unRealizedPnl: 3 })] });

    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1234.56, equity: 5678.9 },
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
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

    const monitor = makeMonitor(client, store, onSummary, onAlert);

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

  it("includes pending STOP entries and TP/SL pairs in the summary", async () => {
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ unRealizedPnl: 1 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1, equity: 2 },
    });
    // Trigger (plan) orders — open-side STOP entries only
    client.getPlanOrders.mockResolvedValue({
      data: [
        { id: "817027833053397504", symbol: "TAO_USDT", side: 1, triggerType: 1, triggerPrice: "187.54", vol: "0.5", openType: 1, leverage: 10 },
        { id: "77", symbol: "BTC_USDT", side: 2, triggerType: 1, triggerPrice: 65000, vol: 1, openType: 1, leverage: 10 }, // close-side → excluded
      ],
    });
    // TP/SL orders — one row per position, carries BOTH prices
    client.getStopOrders.mockResolvedValue({
      data: [
        { id: "88", symbol: "XLM_USDT", positionType: 1, takeProfitPrice: 0.1788, stopLossPrice: 0.1677, vol: 110, openType: 1 },
        { id: "99", symbol: "ETH_USDT", positionType: 2, takeProfitPrice: 1856, stopLossPrice: 1884.95, vol: 0.17, openType: 1 },
      ],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();
    await monitor.emitSummary();

    const summary: PositionSummary = onSummary.mock.calls[0][0];
    expect(summary.pendingOrders).toHaveLength(3);

    const stop = summary.pendingOrders[0];
    expect(stop).toMatchObject({
      orderId: "817027833053397504",
      symbol: "TAO_USDT",
      side: 1,
      kind: "STOP",
      triggerType: 1,
      triggerPrice: 187.54,
      vol: 0.5,
      leverage: 10,
    });

    const tpSlLong = summary.pendingOrders[1];
    expect(tpSlLong).toMatchObject({
      orderId: "88",
      symbol: "XLM_USDT",
      side: 4,
      kind: "TP_SL",
      positionType: 1,
      takeProfitPrice: 0.1788,
      stopLossPrice: 0.1677,
      vol: 110,
    });

    const tpSlShort = summary.pendingOrders[2];
    expect(tpSlShort).toMatchObject({
      symbol: "ETH_USDT",
      side: 2,
      kind: "TP_SL",
      positionType: 2,
      takeProfitPrice: 1856,
      stopLossPrice: 1884.95,
      vol: 0.17,
    });
  });

  it("keeps the other source when one pending-orders fetch fails", async () => {
    client.getOpenPositions.mockResolvedValue({
      data: [makePosition({ unRealizedPnl: 1 })],
    });
    client.getAccountAsset.mockResolvedValue({
      data: { availableBalance: 1, equity: 2 },
    });
    client.getPlanOrders.mockRejectedValue(new Error("rate limited"));
    client.getStopOrders.mockResolvedValue({
      data: [
        { id: "88", symbol: "XLM_USDT", positionType: 1, takeProfitPrice: 0.1788, stopLossPrice: 0.1677, vol: 110 },
      ],
    });

    const monitor = makeMonitor(client, store, onSummary, onAlert);
    await monitor.sample();
    await monitor.emitSummary();

    const summary: PositionSummary = onSummary.mock.calls[0][0];
    expect(summary.pendingOrders).toHaveLength(1); // TP/SL still shown
    expect(summary.pendingOrders[0].kind).toBe("TP_SL");
    expect(summary.openPositions).toHaveLength(1); // summary still emitted
  });
});
