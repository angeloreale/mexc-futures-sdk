import { parseSignal, parseSignals, normalizeSymbol } from "../parser";

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

  it("warns on invalid SL direction for BUY (SL above entry) but still accepts", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 66000 TP 67000");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.entry).toBe(65000);
    expect(result!.sl).toBe(66000);
  });

  it("warns on invalid SL direction for SELL (SL below entry) but still accepts", () => {
    const result = parseSignal("SELL BTCUSDT@65000 SL 64000 TP 63000");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("SELL");
    expect(result!.entry).toBe(65000);
    expect(result!.sl).toBe(64000);
  });

  it("warns on invalid TP direction for BUY (TP below entry) but still accepts", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 63000");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.entry).toBe(65000);
    expect(result!.tp).toEqual([63000]);
  });

  it("warns on invalid TP direction for SELL (TP above entry) but still accepts", () => {
    const result = parseSignal("SELL BTCUSDT@65000 SL 66000 TP 67000");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("SELL");
    expect(result!.entry).toBe(65000);
    expect(result!.tp).toEqual([67000]);
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

  // --- Trigger order: TPs below entry for BUY should be accepted ---
  // The entry is a trigger price, not a guaranteed fill. User explicitly chose targets.
  it("accepts trigger BUY with TPs below entry price", () => {
    const result = parseSignal(
      "BUY ZECUSDT@469 SL 459.41 TP1 467.72 TP2 468.80 TP3 471.42"
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("BUY");
    expect(result!.entry).toBe(469);
    expect(result!.sl).toBe(459.41);
    expect(result!.tp).toEqual([467.72, 468.80, 471.42]);
    expect(result!.orderType).toBe("trigger");
  });

  it("accepts trigger SELL with TPs above entry price", () => {
    const result = parseSignal(
      "SELL ZECUSDT@440 SL 450 TP1 445 TP2 448 TP3 430"
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("SELL");
    expect(result!.entry).toBe(440);
    expect(result!.sl).toBe(450);
    expect(result!.tp).toEqual([445, 448, 430]);
    expect(result!.orderType).toBe("trigger");
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

// ── parseSignals – multi-line ────────────────────────────────────────────

describe("parseSignals", () => {
  it("parses multiple signals from a multi-line message", () => {
    const text = [
      "SELL TAOUSDT@190.08 SL 198.84 TP1 188.89 TP2 188.25 TP 188.07",
      "BUY USDCNH@6.77059 SL 6.76867 TP1 6.7714 TP2 6.7727 TP3 6.7744",
      "BUY BNBUSDT@571.22 SL 569.68 TP1 571.49 TP2 572.21 TP3 573.32",
    ].join("\n");

    const signals = parseSignals(text);
    expect(signals).toHaveLength(3);

    expect(signals[0].action).toBe("SELL");
    expect(signals[0].rawSymbol).toBe("TAOUSDT");
    expect(signals[0].entry).toBe(190.08);
    expect(signals[0].tp).toEqual([188.89, 188.25, 188.07]);

    expect(signals[1].action).toBe("BUY");
    expect(signals[1].rawSymbol).toBe("USDCNH");
    expect(signals[1].entry).toBe(6.77059);
    expect(signals[1].tp).toEqual([6.7714, 6.7727, 6.7744]);

    expect(signals[2].action).toBe("BUY");
    expect(signals[2].rawSymbol).toBe("BNBUSDT");
    expect(signals[2].entry).toBe(571.22);
    expect(signals[2].tp).toEqual([571.49, 572.21, 573.32]);
  });

  it("returns a single signal when the message has one line", () => {
    const signals = parseSignals("BUY ETHUSDT@3500 SL 3400 TP 3600");
    expect(signals).toHaveLength(1);
    expect(signals[0].action).toBe("BUY");
  });

  it("skips non-signal lines and returns only valid ones", () => {
    const text = [
      "SELL BTCUSDT@65000 SL 66000 TP 63000",
      "Hello, how are you?",
      "BUY ETHUSDT@3500 SL 3400 TP 3600",
    ].join("\n");

    const signals = parseSignals(text);
    expect(signals).toHaveLength(2);
    expect(signals[0].rawSymbol).toBe("BTCUSDT");
    expect(signals[1].rawSymbol).toBe("ETHUSDT");
  });

  it("returns empty array for non-signal text", () => {
    expect(parseSignals("Hello, how are you?")).toHaveLength(0);
    expect(parseSignals("")).toHaveLength(0);
  });

  it("returns empty array for null/undefined input", () => {
    expect(parseSignals(null as any)).toHaveLength(0);
    expect(parseSignals(undefined as any)).toHaveLength(0);
  });

  it("propagates messageId and chatId to every signal", () => {
    const text = [
      "SELL BTCUSDT@65000 SL 66000 TP 63000",
      "BUY ETHUSDT@3500 SL 3400 TP 3600",
    ].join("\n");

    const signals = parseSignals(text, 999, -100456, 1700000000);
    expect(signals).toHaveLength(2);
    expect(signals[0].messageId).toBe(999);
    expect(signals[0].chatId).toBe(-100456);
    expect(signals[0].timestamp).toBe(1700000000);
    expect(signals[1].messageId).toBe(999);
    expect(signals[1].chatId).toBe(-100456);
    expect(signals[1].timestamp).toBe(1700000000);
  });
});

// ── Risk override ────────────────────────────────────────────────────────

describe("parseSignal risk override", () => {
  it("parses R2.5 as 2.5% risk", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 R2.5");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBe(2.5);
  });

  it("parses R6 as 6% risk", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 R6");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBe(6);
  });

  it("parses R0 as 0% risk", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 R0");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBe(0);
  });

  it("parses R1.5 as 1.5% risk with multiple TPs", () => {
    const result = parseSignal(
      "SELL BTCUSDT@65000 SL 66000 TP1 64000 TP2 63000 R1.5"
    );
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBe(1.5);
    expect(result!.tp).toEqual([64000, 63000]);
  });

  it("parses R3 as 3% risk on market entry", () => {
    const result = parseSignal("BUY BTCUSDT SL 50000 TP 52000 R3");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBe(3);
    expect(result!.entry).toBe(0); // market entry
  });

  it("ignores R values out of range (>6)", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 R7");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBeUndefined();
  });

  it("ignores R values out of range (<0)", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 R-1");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBeUndefined();
  });

  it("has no riskPercentOverride when no R marker present", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000");
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBeUndefined();
  });

  it("parses R marker at the end with market entry and multiple TPs", () => {
    const result = parseSignal(
      "BUY ZECUSDT SL 459.41 TP1 467.72 TP2 468.80 TP3 471.42 R4"
    );
    expect(result).not.toBeNull();
    expect(result!.riskPercentOverride).toBe(4);
    expect(result!.tp).toEqual([467.72, 468.80, 471.42]);
  });
});

// ── Leverage override ─────────────────────────────────────────────────────

describe("parseSignal leverage override", () => {
  it("parses L200 as 200x leverage", () => {
    const result = parseSignal("BUY TAOUSDT@123 SL 122 TP1 124 TP2 125 L200");
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBe(200);
    expect(result!.tp).toEqual([124, 125]);
  });

  it("parses L5 as 5x leverage", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 L5");
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBe(5);
  });

  it("parses L combined with R and V markers", () => {
    const result = parseSignal(
      "BUY TAOUSDT@123 SL 122 TP1 124 TP2 125 V7 R3 L50"
    );
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBe(50);
    expect(result!.riskPercentOverride).toBe(3);
    expect(result!.executeCycle).toBe(2); // V7 → 7 days
  });

  it("parses L on a market entry signal", () => {
    const result = parseSignal("BUY BTCUSDT SL 50000 TP 52000 L20");
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBe(20);
    expect(result!.entry).toBe(0); // market entry
  });

  it("ignores L values out of range (>200)", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 L250");
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBeUndefined();
  });

  it("ignores L0 (leverage must be >= 1)", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000 L0");
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBeUndefined();
  });

  it("does not mistake SL for a leverage marker", () => {
    const result = parseSignal("BUY BTCUSDT@65000 SL 64000 TP 66000");
    expect(result).not.toBeNull();
    expect(result!.leverageOverride).toBeUndefined();
    expect(result!.sl).toBe(64000);
  });
});
