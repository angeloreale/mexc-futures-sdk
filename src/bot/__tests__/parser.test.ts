import { parseSignal, normalizeSymbol } from "../parser";

describe("parseSignal", () => {
  it("parses a BUY signal with single TP", () => {
    const result = parseSignal("BUY TAOUSDT@187.54 SL 185.13 TP 188.81");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.rawSymbol).toBe("TAOUSDT");
    expect(result!.entry).toBe(187.54);
    expect(result!.sl).toBe(185.13);
    expect(result!.tp).toEqual([188.81]);
  });

  it("parses a BUY signal with multiple TPs", () => {
    const result = parseSignal(
      "BUY USDJPY@163.89 SL 163.77 TP1 163.94 TP2 163.97 TP3 163.99"
    );
    // USDJPY won't have a valid SL direction for BUY (SL < entry) — wait, 163.77 < 163.89, so valid
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.rawSymbol).toBe("USDJPY");
    expect(result!.entry).toBe(163.89);
    expect(result!.sl).toBe(163.77);
    expect(result!.tp).toEqual([163.94, 163.97, 163.99]);
  });

  it("parses a SELL signal with single TP", () => {
    const result = parseSignal("SELL BTCUSDT@65000 SL 66000 TP 63000");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("SELL");
    expect(result!.rawSymbol).toBe("BTCUSDT");
    expect(result!.entry).toBe(65000);
    expect(result!.sl).toBe(66000);
    expect(result!.tp).toEqual([63000]);
  });

  it("parses a BUY signal with no TP (default will be applied later)", () => {
    const result = parseSignal("BUY ETHUSDT@3500 SL 3400");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.rawSymbol).toBe("ETHUSDT");
    expect(result!.entry).toBe(3500);
    expect(result!.sl).toBe(3400);
    expect(result!.tp).toEqual([]);
  });

  it("is case-insensitive for action", () => {
    const result = parseSignal("buy ETHUSDT@3500 sl 3400 tp 3600");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
  });

  it("rejects invalid SL direction for BUY (SL above entry)", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 66000 TP 67000");
    expect(result).toBeNull();
  });

  it("rejects invalid SL direction for SELL (SL below entry)", () => {
    const result = parseSignal("SELL BTCUSDT@65000 SL 64000 TP 63000");
    expect(result).toBeNull();
  });

  it("rejects invalid TP direction for BUY (TP below entry)", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 63000");
    expect(result).toBeNull();
  });

  it("rejects invalid TP direction for SELL (TP above entry)", () => {
    const result = parseSignal("SELL BTCUSDT@65000 SL 66000 TP 67000");
    expect(result).toBeNull();
  });

  it("returns null for non-signal text", () => {
    expect(parseSignal("Hello, how are you?")).toBeNull();
    expect(parseSignal("")).toBeNull();
    expect(parseSignal("BUY some stuff")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parseSignal(null as any)).toBeNull();
    expect(parseSignal(undefined as any)).toBeNull();
  });

  it("preserves messageId and chatId", () => {
    const result = parseSignal(
      "BUY ETHUSDT@3500 SL 3400 TP 3600",
      12345,
      -100123,
      1700000000
    );
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(12345);
    expect(result!.chatId).toBe(-100123);
    expect(result!.timestamp).toBe(1700000000);
  });

  it("handles extra whitespace", () => {
    const result = parseSignal(
      "  BUY   TAOUSDT@187.54   SL   185.13   TP   188.81  "
    );
    expect(result).not.toBeNull();
    expect(result!.rawSymbol).toBe("TAOUSDT");
  });

  // --- Market entry (no @/EP) ---

  it("parses a BUY market signal with multiple TPs", () => {
    const result = parseSignal(
      "BUY ZECUSDT SL 459.41 TP1 467.72 TP2 468.80 TP3 471.42"
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.rawSymbol).toBe("ZECUSDT");
    expect(result!.entry).toBe(0); // market sentinel
    expect(result!.sl).toBe(459.41);
    expect(result!.tp).toEqual([467.72, 468.80, 471.42]);
  });

  it("parses a BUY market signal with single TP", () => {
    const result = parseSignal("BUY BTCUSDT SL 50000 TP 52000");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.rawSymbol).toBe("BTCUSDT");
    expect(result!.entry).toBe(0);
    expect(result!.sl).toBe(50000);
    expect(result!.tp).toEqual([52000]);
  });

  it("parses a SELL market signal", () => {
    const result = parseSignal("SELL ETHUSDT SL 3500 TP1 3300 TP2 3200");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("SELL");
    expect(result!.rawSymbol).toBe("ETHUSDT");
    expect(result!.entry).toBe(0);
    expect(result!.sl).toBe(3500);
    expect(result!.tp).toEqual([3300, 3200]);
  });

  it("parses a market signal with no TP", () => {
    const result = parseSignal("BUY BTCUSDT SL 50000");
    expect(result).not.toBeNull();
    expect(result!.entry).toBe(0);
    expect(result!.sl).toBe(50000);
    expect(result!.tp).toEqual([]);
  });

  it("does NOT validate SL/TP direction for market entries", () => {
    // For market entries, we don't know entry price yet, so any SL/TP is accepted
    const result = parseSignal("BUY BTCUSDT SL 99999");
    expect(result).not.toBeNull();
    expect(result!.entry).toBe(0);
  });

  // --- EP format (alternative to @) ---

  it("parses EP format as entry price", () => {
    const result = parseSignal("BUY ZECUSDT EP 460 SL 459.41 TP1 467.72");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.rawSymbol).toBe("ZECUSDT");
    expect(result!.entry).toBe(460);
    expect(result!.sl).toBe(459.41);
    expect(result!.tp).toEqual([467.72]);
  });
});

describe("normalizeSymbol", () => {
  it("converts TAOUSDT to TAO_USDT", () => {
    expect(normalizeSymbol("TAOUSDT")).toBe("TAO_USDT");
  });

  it("converts BTCUSDT to BTC_USDT", () => {
    expect(normalizeSymbol("BTCUSDT")).toBe("BTC_USDT");
  });

  it("converts ETHUSDT to ETH_USDT", () => {
    expect(normalizeSymbol("ETHUSDT")).toBe("ETH_USDT");
  });

  it("converts ETHBTC to ETH_BTC", () => {
    expect(normalizeSymbol("ETHBTC")).toBe("ETH_BTC");
  });

  it("passes through already-normalized symbols", () => {
    expect(normalizeSymbol("BTC_USDT")).toBe("BTC_USDT");
  });

  it("returns null for unknown quote currencies", () => {
    expect(normalizeSymbol("USDJPY")).toBeNull();
  });

  it("handles lowercase input", () => {
    expect(normalizeSymbol("btcusdt")).toBe("BTC_USDT");
  });

  it("returns null for symbol that IS the quote currency", () => {
    // "USDT" alone — base would be empty
    expect(normalizeSymbol("USDT")).toBeNull();
  });
});
