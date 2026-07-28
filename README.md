# MEXC Futures SDK

A TypeScript SDK for MEXC Futures trading with REST API and WebSocket support.

⚠️ **DISCLAIMER**: This SDK uses browser session tokens and reverse-engineered endpoints. MEXC does not officially support futures trading through API. Use at your own risk.

<p align="center">
  <a href="https://discord.gg/bZeQd4rMW9"><img src="https://img.shields.io/badge/Discord-MEXC%20Traders-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join MEXC Traders on Discord"></a>
  <a href="https://t.me/yobebka"><img src="https://img.shields.io/badge/Telegram-Contact-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Contact on Telegram"></a>
  <a href="https://www.npmjs.com/package/mexc-futures-sdk"><img src="https://img.shields.io/npm/v/mexc-futures-sdk?style=for-the-badge&logo=npm&color=CB3837" alt="npm version"></a>
</p>

## 💬 Community

Join the **[MEXC Traders Discord](https://discord.gg/bZeQd4rMW9)** — discuss MEXC trading, this SDK, strategies, and get help. For direct contact: **[Telegram @yobebka](https://t.me/yobebka)**.

## Features

- ✅ **REST API** - Complete trading functionality
- ✅ **WebSocket** - Real-time market data and account updates
- ✅ **TypeScript** - Full type definitions
- ✅ **Auto-reconnect** - Reliable WebSocket connections
- ✅ **Error handling** - Comprehensive error management

## Installation

```bash
npm install mexc-futures-sdk
```

## Quick Start

### REST API

```typescript
import { MexcFuturesClient } from "mexc-futures-sdk";

const client = new MexcFuturesClient({
  authToken: "WEB_YOUR_TOKEN_HERE", // Get from browser Developer Tools
});

// Get ticker data
const ticker = await client.getTicker("BTC_USDT");
console.log("BTC Price:", ticker.data.lastPrice);

// Place a market order
const order = await client.submitOrder({
  symbol: "BTC_USDT",
  price: 50000,
  vol: 0.001,
  side: 1, // 1=open long, 3=open short
  type: 5, // 5=market order
  openType: 1, // 1=isolated margin
  leverage: 10,
});
```

### WebSocket

```typescript
import { MexcFuturesWebSocket } from "mexc-futures-sdk";

const ws = new MexcFuturesWebSocket({
  apiKey: "YOUR_API_KEY",
  secretKey: "YOUR_SECRET_KEY",
  autoReconnect: true,
});

// Connect and login
ws.on("connected", () => {
  ws.login(false).then(() => {
    console.log("Login successful");
    ws.subscribeToAll(); // Subscribe to all private data
  });
});

// Handle trading events
ws.on("orderUpdate", (data) => {
  console.log("Order Update:", data.orderId, data.symbol, data.state);
});

ws.on("positionUpdate", (data) => {
  console.log("Position:", data.symbol, data.holdVol, data.pnl);
});

ws.on("assetUpdate", (data) => {
  console.log("Balance:", data.currency, data.availableBalance);
});

await ws.connect();
```

## Authentication

### REST API - Browser Session Token

1. Login to MEXC futures in your browser
2. Open Developer Tools (F12) → Network tab
3. Make any request to futures.mexc.com
4. Find the `authorization` header (starts with "WEB...")
5. Copy the token value

### WebSocket - API Keys

1. Go to MEXC API Management
2. Create API Key and Secret
3. Enable futures trading permissions

## WebSocket Events

### Private Data Events

| Event            | Description           | Data                                 |
| ---------------- | --------------------- | ------------------------------------ |
| `orderUpdate`    | Order status changes  | Order details, state, fills          |
| `orderDeal`      | Order executions      | Trade details, fees, profit          |
| `positionUpdate` | Position changes      | Size, PnL, margin, liquidation price |
| `assetUpdate`    | Balance changes       | Available, frozen, position margin   |
| `stopOrder`      | Stop-loss/take-profit | Stop prices for positions            |
| `liquidateRisk`  | Liquidation warnings  | Margin ratio, liquidation price      |

### Public Data Events (Optional)

| Event     | Description         | Data                                  |
| --------- | ------------------- | ------------------------------------- |
| `tickers` | All symbol prices   | Price, volume, change for all symbols |
| `ticker`  | Single symbol price | Real-time price updates               |
| `depth`   | Order book          | Bids and asks                         |
| `kline`   | Candlestick data    | OHLCV data                            |
| `deal`    | Recent trades       | Trade executions                      |

## WebSocket Subscription Options

### Option 1: All Private Data (Recommended)

```typescript
ws.on("login", () => {
  ws.subscribeToAll(); // Get all trading events
});
```

### Option 2: Filtered by Symbols

```typescript
ws.on("login", () => {
  ws.subscribeToMultiple([
    {
      filter: "order",
      rules: ["BTC_USDT", "ETH_USDT"], // Only these symbols
    },
    {
      filter: "position",
      rules: ["BTC_USDT", "ETH_USDT"],
    },
    {
      filter: "asset", // All balance updates
    },
  ]);
});
```

### Option 3: Public Market Data

```typescript
// Subscribe to market data
ws.subscribeToAllTickers(); // All symbol prices
ws.subscribeToTicker("BTC_USDT"); // Single symbol
ws.subscribeToDepth("BTC_USDT"); // Order book
ws.subscribeToKline("BTC_USDT", "Min1"); // 1-minute candles
```

## Order Types and Parameters

### Order Sides

- `1` = Open long position
- `2` = Close short position
- `3` = Open short position
- `4` = Close long position

### Order Types

- `1` = Limit order
- `5` = Market order
- `3` = IOC (Immediate or Cancel)
- `4` = FOK (Fill or Kill)

### Order States (WebSocket)

- `1` = New
- `2` = Pending
- `3` = Filled
- `4` = Cancelled

### Example Orders

```typescript
// Market order
await client.submitOrder({
  symbol: "BTC_USDT",
  price: 50000, // Required even for market orders
  vol: 0.001,
  side: 1, // Open long
  type: 5, // Market
  openType: 1, // Isolated margin
  leverage: 10,
});

// Limit order with stop-loss
await client.submitOrder({
  symbol: "BTC_USDT",
  price: 49000,
  vol: 0.001,
  side: 1, // Open long
  type: 1, // Limit
  openType: 1, // Isolated margin
  leverage: 10,
  stopLossPrice: 45000,
  takeProfitPrice: 55000,
});

// Close position
await client.submitOrder({
  symbol: "BTC_USDT",
  price: 51000,
  vol: 0.001,
  side: 4, // Close long
  type: 5, // Market
  openType: 1,
  positionId: 12345, // Position to close
});
```

## Error Handling

The SDK provides comprehensive error handling with user-friendly error messages and specific error types.

### Error Types

```typescript
import {
  MexcAuthenticationError,
  MexcSignatureError,
  MexcApiError,
  MexcNetworkError,
  MexcValidationError,
  MexcRateLimitError,
  MexcFuturesError,
} from "mexc-futures-sdk";
```

### Handling Different Error Types

```typescript
try {
  const asset = await client.getAccountAsset("USDT");
  console.log("Success:", asset);
} catch (error) {
  if (error instanceof MexcAuthenticationError) {
    console.log("❌ Authentication failed. Please update your WEB token.");
  } else if (error instanceof MexcSignatureError) {
    console.log("❌ Signature verification failed. Get a fresh WEB token.");
  } else if (error instanceof MexcRateLimitError) {
    console.log("❌ Rate limit exceeded. Please wait before retrying.");
    if (error.retryAfter) {
      console.log(`Retry after ${error.retryAfter} seconds`);
    }
  } else if (error instanceof MexcNetworkError) {
    console.log("❌ Network error. Check your internet connection.");
  } else if (error instanceof MexcValidationError) {
    console.log(`❌ Validation error: ${error.message}`);
  } else if (error instanceof MexcApiError) {
    console.log(`❌ API error (${error.statusCode}): ${error.message}`);
  }

  // Get detailed error information for debugging
  if (error instanceof MexcFuturesError) {
    console.log("Error details:", error.getDetails());
  }
}
```

### User-Friendly Error Messages

All errors provide user-friendly messages through `getUserFriendlyMessage()`:

```typescript
try {
  await client.submitOrder({...});
} catch (error) {
  if (error instanceof MexcFuturesError) {
    console.log(error.getUserFriendlyMessage());
    // Example: "❌ Authentication failed. Your authorization token may be expired or invalid. Please update your WEB token from browser Developer Tools."
  }
}
```

### Common Error Scenarios

| Error Type                | Common Causes               | Solutions                    |
| ------------------------- | --------------------------- | ---------------------------- |
| `MexcAuthenticationError` | Invalid/expired WEB token   | Get fresh token from browser |
| `MexcSignatureError`      | Token authentication failed | Update WEB token             |
| `MexcRateLimitError`      | Too many requests           | Wait and retry               |
| `MexcNetworkError`        | Connection issues           | Check internet connection    |
| `MexcValidationError`     | Invalid parameters          | Check request parameters     |

### WebSocket Error Handling

```typescript
ws.on("error", (error) => {
  console.error("WebSocket error:", error);
});

ws.on("disconnected", ({ code, reason }) => {
  console.log("Disconnected:", code, reason);
});
```

### Logging Levels

Set `logLevel` to control error verbosity:

```typescript
const client = new MexcFuturesClient({
  authToken: "WEB_YOUR_TOKEN",
  logLevel: "INFO", // "SILENT", "ERROR", "WARN", "INFO", "DEBUG"
});
```

- `ERROR`: Only error messages
- `INFO`: User-friendly error messages
- `DEBUG`: Detailed error information for debugging

## Complete Example

See `examples/websocket.ts` for a complete working example with:

- Connection management
- Event handlers for all data types
- Error handling
- Graceful shutdown

```bash
# Run the example
npm install
ts-node examples/websocket.ts
```

## API Reference

### REST Methods

- `getTicker(symbol)` - Get ticker data
- `getContractDetail(symbol?)` - Get contract info
- `getContractDepth(symbol, limit?)` - Get order book
- `submitOrder(params)` - Place order
- `cancelOrder(orderIds)` - Cancel orders
- `getOrderHistory(params)` - Get order history
- `getPositionHistory(params)` - Get position history
- `getAssets()` - Get account balance

### WebSocket Methods

- `connect()` - Connect to WebSocket
- `login(subscribe?)` - Login and optionally auto-subscribe
- `subscribeToAll()` - Subscribe to all private data
- `subscribeToMultiple(filters)` - Subscribe with filters
- `subscribeToTicker(symbol)` - Market data subscriptions
- `disconnect()` - Close connection

## 🤖 Telegram Signal Bot

The SDK includes a built-in Telegram signal bot that listens for trading signals on configured channels and automatically executes trades on MEXC Futures.

### Signal Formats

The bot recognizes these signal formats:

```
BUY TAOUSDT@187.54 SL 185.13 TP 188.81
SELL BTCUSDT@65000 SL 66000 TP 63000
BUY ETHUSDT@3500 SL 3400 TP1 3600 TP2 3700 TP3 3800
BUY SOLUSDT@150 SL 145
```

- **BUY** = open long, **SELL** = open short
- **SL** = stop-loss price (mandatory)
- **TP** = take-profit (optional — defaults to 1.5× risk distance)
- Multiple TPs (TP1, TP2, TP3) split volume equally across targets
- Symbols are normalized: `TAOUSDT` → `TAO_USDT`

### Quick Start

1. Copy `.env.example` to `.env` and fill in your credentials
2. Start in dry-run mode first:

```bash
# Development
npm run bot

# Production
npm run build
npm run bot:start
```

### Configuration

All settings come from environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `MEXC_AUTH_TOKEN` | — | WEB auth token from browser |
| `TELEGRAM_BOT_TOKEN` | — | Bot API token from @BotFather |
| `ALLOWED_CHANNELS` | — | Comma-separated channel/chat IDs |
| `DEFAULT_LEVERAGE` | `10` | Default leverage (1–200) |
| `OPEN_TYPE` | `1` | 1 = isolated, 2 = cross |
| `RISK_PERCENT` | `0.01` | Risk per trade (0.01 = 1% of equity) |
| `DEFAULT_TP_RATIO` | `1.5` | TP:SL ratio when no TP given |
| `MAX_CONCURRENT_TRADES` | `5` | Max open positions |
| `MAX_NOTIONAL_PER_TRADE` | `10000` | Max notional per trade (USDT) |
| `DRY_RUN` | `true` | Parse/size but don't submit orders |
| `TRADING_ENABLED` | `true` | Master trading switch |

### Linux Deployment

A systemd service file is provided in `deploy/mexc-signal-bot.service`:

```bash
# Create service user
sudo useradd -r -s /bin/false mexcbot

# Deploy
sudo cp -r . /opt/mexc-signal-bot
sudo cp deploy/mexc-signal-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mexc-signal-bot

# View logs
sudo journalctl -u mexc-signal-bot -f
```

### Safety Features

- **Dry-run mode** — verify parsing and sizing without submitting orders
- **Idempotency** — duplicate signals are never executed twice
- **Position limits** — configurable max concurrent trades
- **Notional cap** — max USDT value per trade
- **Symbol validation** — only trades on active, API-allowed MEXC contracts
- **Risk-based sizing** — automatically calculates volume from equity and stop distance

## Support

This is an unofficial SDK. Use at your own risk. For issues and feature requests, please open a GitHub issue.

## License

MIT
