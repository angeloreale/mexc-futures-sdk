import { TradeExecutor } from "../executor";
import { Logger } from "../../utils/logger";
import { BotConfig, ResolvedTrade, TradeSignal } from "../types";

const logger = new Logger({ level: "SILENT" });

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    mexcApiKey: "",
    mexcSecretKey: "",
    mexcAuthToken: "test",
    telegramBotToken: "test",
    allowedChannels: ["123"],
    leverage: 10,
    openType: 1,
    riskPercent: 0.01,
    defaultTpRatio: 1.5,
    maxConcurrentTrades: 5,
    maxNotionalPerTrade: 100000,
    dryRun: false,
    tradingEnabled: true,
    useLimitTpSl: false,
    logLevel: "SILENT",
    baseCurrency: "USDT",
    stateFilePath: "/tmp/test-state.json",
    logDir: "/tmp/test-logs",
    logRetentionDays: 90,
    pnlNotificationChannel: "",
    positionMonitorIntervalSeconds: 30,
    summaryNotificationChannel: "",
    summaryIntervalHours: 8,
    summaryWindowHours: 4,
    orderRateCapacity: 3,
    orderRateIntervalMs: 200,
    signalResolverChannels: [],
    signalResolverIntervalSeconds: 15,
    splitMultiTp: false,
    ...overrides,
  };
}

function makeTrade(overrides?: Partial<ResolvedTrade>): ResolvedTrade {
  const signal: TradeSignal = {
    raw: "BUY BTCUSDT 66000 SL 65000 TP 68000",
    action: "BUY",
    rawSymbol: "BTCUSDT",
    entry: 66000,
    sl: 65000,
    tp: [68000],
    orderType: "market",
    messageId: 1,
    chatId: "123",
  };
  return {
    signal,
    mexcSymbol: "BTC_USDT",
    volume: 1,
    side: 1,
    leverage: 10,
    openType: 1,
    entry: 66000,
    stopLossPrice: 65000,
    takeProfitPrice: 68000,
    allTpTargets: [68000],
    equity: 10000,
    riskPercent: 0.01,
    riskAmount: 100,
    minVol: 0.001,
    volScale: 3,
    volUnit: 0.001,
    currentPrice: 66000,
    contractSize: 1,
    ...overrides,
  };
}

describe("TradeExecutor limit (maker) TP/SL mode", () => {
  let client: any;

  beforeEach(() => {
    client = {
      submitOrder: jest.fn(),
      submitStopOrder: jest.fn(),
      submitPlanOrder: jest.fn(),
      getOrder: jest.fn(),
      getOpenPositions: jest.fn(),
    };
  });

  it("submits a market entry WITHOUT attached TP/SL and places limit TP + SL via stoporder/place", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "order-1" });
    client.getOrder.mockResolvedValue({
      success: true,
      code: 0,
      data: { positionId: 111 },
    });
    client.submitStopOrder.mockResolvedValue({ success: true, code: 0, data: "stop-1" });

    const executor = new TradeExecutor(client, makeConfig({ useLimitTpSl: true }), logger);
    const records = await executor.execute(makeTrade());

    // Entry order must NOT carry market TP/SL attachments in limit mode.
    const orderParams = client.submitOrder.mock.calls[0][0];
    expect(orderParams.stopLossPrice).toBeUndefined();
    expect(orderParams.takeProfitPrice).toBeUndefined();

    // Limit SL placed first, then Limit TP — both against the resolved positionId.
    expect(client.submitStopOrder).toHaveBeenCalledTimes(2);
    const [slReq, tpReq] = client.submitStopOrder.mock.calls.map((c: any[]) => c[0]);
    expect(slReq).toMatchObject({
      positionId: 111,
      vol: 1,
      stopLossType: 1,
      stopLossOrderPrice: 65000,
      stopLossPrice: 65000,
    });
    expect(tpReq).toMatchObject({
      positionId: 111,
      vol: 1,
      takeProfitType: 1,
      takeProfitOrderPrice: 68000,
      takeProfitPrice: 68000,
    });

    expect(records[0].success).toBe(true);
  });

  it("keeps attached market TP/SL when limit mode is disabled (default)", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "order-1" });

    const executor = new TradeExecutor(client, makeConfig({ useLimitTpSl: false }), logger);
    const records = await executor.execute(makeTrade());

    const orderParams = client.submitOrder.mock.calls[0][0];
    expect(orderParams.stopLossPrice).toBe(65000);
    expect(orderParams.takeProfitPrice).toBe(68000);
    expect(client.submitStopOrder).not.toHaveBeenCalled();
    expect(records[0].success).toBe(true);
  });

  it("falls back to MARKET TP/SL via stoporder/place when the limit placement fails", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "order-1" });
    client.getOrder.mockResolvedValue({
      success: true,
      code: 0,
      data: { positionId: 222 },
    });
    client.submitStopOrder
      // Limit SL → rejected, Market SL fallback → ok, Limit TP → rejected, Market TP fallback → ok
      .mockResolvedValueOnce({ success: false, code: 999, message: "limit rejected" })
      .mockResolvedValueOnce({ success: true, code: 0, data: "stop-sl" })
      .mockResolvedValueOnce({ success: false, code: 999, message: "limit rejected" })
      .mockResolvedValueOnce({ success: true, code: 0, data: "stop-tp" });

    const executor = new TradeExecutor(client, makeConfig({ useLimitTpSl: true }), logger);
    await executor.execute(makeTrade());

    expect(client.submitStopOrder).toHaveBeenCalledTimes(4);
    const reqs = client.submitStopOrder.mock.calls.map((c: any[]) => c[0]);
    // Limit SL → market SL fallback → Limit TP → market TP fallback.
    expect(reqs[0]).toMatchObject({ stopLossType: 1 });
    expect(reqs[1].stopLossType).toBeUndefined();
    expect(reqs[2]).toMatchObject({ takeProfitType: 1 });
    expect(reqs[3].takeProfitType).toBeUndefined();
  });
});
