import axios, { AxiosInstance } from "axios";
import { ENDPOINTS } from "./utils/constants";
import { generateHeaders } from "./utils/headers";
import { Logger, LogLevelString } from "./utils/logger";
import { TokenBucket, TokenBucketOptions } from "./utils/rateLimiter";
import {
  MexcValidationError,
  MexcApiError,
  parseAxiosError,
  formatErrorForLogging,
} from "./utils/errors";
import {
  OrderHistoryParams,
  OrderHistoryResponse,
  OrderDealsParams,
  OrderDealsResponse,
  CancelOrderResponse,
  CancelOrderByExternalIdRequest,
  CancelOrderByExternalIdResponse,
  CancelAllOrdersRequest,
  CancelAllOrdersResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
  SubmitTriggerOrderRequest,
  SubmitTriggerOrderResponse,
  SubmitPlanOrderRequest,
  SubmitPlanOrderResponse,
  GetOrderResponse,
  PendingPlanOrdersResponse,
} from "./types/orders";
import {
  RiskLimit,
  FeeRate,
  AccountResponse,
  AccountAssetResponse,
  OpenPositionsResponse,
  PositionHistoryParams,
  PositionHistoryResponse,
} from "./types/account";
import {
  TickerResponse,
  ContractDetailResponse,
  ContractDepthResponse,
} from "./types/market";
import JSONBigInt from "json-bigint";

// Big-int-safe + prototype-pollution-hardened JSON parser for HTTP responses.
// storeAsString: ids > 2^53 are returned as exact STRINGS (not native bigint) — this preserves
// precision AND stays JSON.stringify-safe (native bigint throws on JSON.stringify, breaking any
// consumer that logs/persists a response); protoAction/constructorAction "ignore": drop
// `__proto__`/`constructor` keys from untrusted responses.
const jsonBig = JSONBigInt({
  storeAsString: true,
  protoAction: "ignore",
  constructorAction: "ignore",
});

export interface MexcFuturesSDKConfig {
  /** MEXC API key (e.g. "mx0...") — preferred for programmatic trading */
  apiKey?: string;
  /** MEXC API secret key — required when apiKey is set */
  secretKey?: string;
  /** WEB authentication key from browser session (legacy, starts with "WEB...") */
  authToken?: string;
  baseURL?: string;
  timeout?: number;
  userAgent?: string;
  customHeaders?: Record<string, string>;
  logLevel?: LogLevelString;
  /** Optional token-bucket rate limiter applied to EVERY API request.
   * Set this to throttle bursts (e.g. several order/TP submissions from one
   * signal) so the SDK stays within MEXC's request limits instead of getting
   * rejected with code 513. Requests fire immediately during bursts and are
   * only spaced out once the configured budget is exhausted. */
  rateLimit?: TokenBucketOptions;
}

export class MexcFuturesSDK {
  private httpClient: AxiosInstance;
  private config: MexcFuturesSDKConfig;
  private logger: Logger;
  private rateLimiter: TokenBucket | null = null;

  constructor(config: MexcFuturesSDKConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel);

    // Optional token-bucket rate limiter — gates every HTTP request so bursts
    // (e.g. multiple orders + TPs from a single signal) never exceed MEXC's
    // request limit. Bursts fire ASAP; only the overflow is spaced out.
    if (config.rateLimit) {
      this.rateLimiter = new TokenBucket({
        ...config.rateLimit,
        logger: this.logger,
        name: "mexc-api",
      });
    }

    if (!config.apiKey && !config.authToken) {
      throw new Error(
        "MexcFuturesSDK: either apiKey+secretKey or authToken must be provided"
      );
    }
    if (config.apiKey && !config.secretKey) {
      throw new Error(
        "MexcFuturesSDK: secretKey is required when apiKey is provided"
      );
    }

    this.httpClient = axios.create({
      baseURL: config.baseURL || "https://api.mexc.com/api/v1",
      timeout: config.timeout || 30000,
      // Note: auth headers (ApiKey/Request-Time/Signature) are NOT set here — they are
      // injected fresh by the request interceptor below so every request carries a current
      // timestamp and valid signature.
      // Parse responses with a big-int-safe JSON parser. MEXC order ids exceed
      // Number.MAX_SAFE_INTEGER (e.g. 817027833053397504), and the default JSON.parse
      // silently corrupts them (…397504 -> …397500). JSONBigInt preserves them as BigInt
      // so String(orderId) is exact; falls back to the raw string on non-JSON payloads.
      transformResponse: [
        (data) => {
          try {
            return jsonBig.parse(data);
          } catch {
            return data;
          }
        },
      ],
    });

    // Request interceptor — inject fresh auth headers, start timer & log outgoing request
    this.httpClient.interceptors.request.use(async (requestConfig) => {
      // ── Rate-limit gate ─────────────────────────────────────────────
      // Token-bucket limiter: acquire a slot before every request. Fires
      // immediately during bursts (ASAP) and only delays once the configured
      // budget is exhausted — the minimum spacing needed to avoid MEXC 513.
      if (this.rateLimiter) {
        const started = Date.now();
        await this.rateLimiter.acquire();
        const waited = Date.now() - started;
        if (waited > 0) {
          this.logger.info(
            `⏳ MEXC rate-limit: throttled ${(requestConfig.method ?? "GET").toUpperCase()} ${requestConfig.url ?? ""} (waited ${waited}ms)`
          );
        }
      }

      // Attach start time (after any throttling) so the response interceptor's
      // duration reflects actual network time, not the rate-limit wait.
      (requestConfig as any)._startTime = Date.now();

      const method = (requestConfig.method ?? "GET").toUpperCase();

      // ── Fresh auth headers for EVERY request ──────────────────────────
      // Previously the axios constructor set `headers: generateHeaders(...)` once, which
      // captured a stale timestamp+signature. Private GET endpoints (getAccountAsset,
      // getOpenPositions, etc.) relied on those stale defaults, causing MEXC to reject
      // them with code 513 (rate-limit / invalid signature).
      // Now we generate fresh headers right before each request. The body (requestConfig.data)
      // is passed so POST requests are body-signed; GET requests get timestamp-only signing.
      const bodyForSigning =
        requestConfig.data && typeof requestConfig.data === "string"
          ? requestConfig.data
          : requestConfig.data;
      const freshHeaders = generateHeaders(this.getAuthOptions(), true, bodyForSigning);
      Object.assign(requestConfig.headers, freshHeaders);

      const url = `${requestConfig.baseURL ?? ""}${requestConfig.url ?? ""}`;

      // Console debug (unchanged)
      this.logger.debug(`🌐 ${method} ${url}`);

      // Build a sanitised copy of headers (redact secrets) for the log
      const logHeaders: Record<string, string> = {};
      if (requestConfig.headers) {
        const SENSITIVE = ["authorization", "x-mxc-sign", "x-mxc-nonce", "apiKey", "signature", "request-time"];
        for (const [k, v] of Object.entries(requestConfig.headers)) {
          if (SENSITIVE.includes(k.toLowerCase())) {
            logHeaders[k] = "[REDACTED]";
          } else if (typeof v === "string") {
            logHeaders[k] = v;
          }
        }
      }

      // Persist to http-YYYY-MM-DD.log (always, regardless of log level)
      this.logger.logHttp({
        method,
        url,
        requestHeaders: logHeaders,
        requestBody: requestConfig.data ?? undefined,
      });

      return requestConfig;
    });

    // Response interceptor — log full response/error details
    this.httpClient.interceptors.response.use(
      (response) => {
        const durationMs = Date.now() - ((response.config as any)._startTime ?? Date.now());
        const method = (response.config?.method ?? "GET").toUpperCase();
        const url = `${response.config?.baseURL ?? ""}${response.config?.url ?? ""}`;

        // Console debug (unchanged)
        this.logger.debug(`✅ ${response.status} ${response.statusText}`);

        // Persist full response to http-YYYY-MM-DD.log
        this.logger.logHttp({
          method,
          url,
          responseStatus: response.status,
          responseBody: response.data,
          durationMs,
        });

        return response;
      },
      (error) => {
        const durationMs = Date.now() - ((error.config?._startTime) ?? Date.now());
        const endpoint = error.config?.url;
        const method = (error.config?.method ?? "GET").toUpperCase();
        const url = `${error.config?.baseURL ?? ""}${error.config?.url ?? ""}`;

        // Parse the axios error into a user-friendly MEXC error
        const mexcError = parseAxiosError(
          error,
          endpoint,
          method
        );

        // Log the user-friendly error message to console
        this.logger.error(mexcError.getUserFriendlyMessage());

        // Log detailed error info in debug mode
        if (this.logger.isDebugEnabled()) {
          this.logger.debug(
            "Detailed error info:",
            formatErrorForLogging(mexcError)
          );
        }

        // Extract the raw MEXC response body (already parsed by transformResponse)
        const responseBody = error.response?.data;
        const responseStatus = error.response?.status;

        // Persist full error details to http-YYYY-MM-DD.log (always)
        this.logger.logHttp({
          method,
          url,
          requestBody: error.config?.data ?? undefined,
          responseStatus,
          responseBody,
          error: {
            message: mexcError.message,
            code: mexcError.code,
            data: mexcError instanceof MexcApiError ? (mexcError as MexcApiError).responseData : undefined,
          },
          durationMs,
        });

        return Promise.reject(mexcError);
      }
    );
  }

  /**
   * Build auth options for generateHeaders, preferring API key auth over browser token.
   */
  private getAuthOptions() {
    return {
      apiKey: this.config.apiKey,
      secretKey: this.config.secretKey,
      authToken: this.config.authToken,
      userAgent: this.config.userAgent,
      customHeaders: this.config.customHeaders,
    };
  }

  /**
   * Submit order using /api/v1/private/order/submit endpoint
   * This is the alternative order submission method used by MEXC browser
   */
  async submitOrder(
    orderParams: SubmitOrderRequest
  ): Promise<SubmitOrderResponse> {
    try {
      // Validate params BEFORE signing/sending — this is a live-money endpoint, so a NaN/0/undefined
      // field or a wrong enum must never reach the exchange as a signed order.
      const p = orderParams;
      if (!p || typeof p.symbol !== "string" || p.symbol.length === 0) {
        throw new MexcValidationError("symbol is required", "symbol");
      }
      if (!Number.isFinite(p.price) || p.price < 0) {
        throw new MexcValidationError("price must be a finite number >= 0", "price");
      }
      if (!Number.isFinite(p.vol) || p.vol <= 0) {
        throw new MexcValidationError("vol must be a finite number > 0", "vol");
      }
      if (![1, 2, 3, 4].includes(p.side as number)) {
        throw new MexcValidationError("side must be one of 1,2,3,4", "side");
      }
      if (![1, 2, 3, 4, 5, 6].includes(p.type as number)) {
        throw new MexcValidationError("type must be one of 1..6", "type");
      }
      if (![1, 2].includes(p.openType as number)) {
        throw new MexcValidationError("openType must be 1 (isolated) or 2 (cross)", "openType");
      }
      if (p.leverage !== undefined && (!Number.isFinite(p.leverage) || p.leverage <= 0)) {
        throw new MexcValidationError("leverage must be a finite number > 0", "leverage");
      }
      if (p.positionId !== undefined && !Number.isFinite(p.positionId)) {
        throw new MexcValidationError("positionId must be a finite number", "positionId");
      }
      if (p.stopLossPrice !== undefined && (!Number.isFinite(p.stopLossPrice) || p.stopLossPrice < 0)) {
        throw new MexcValidationError("stopLossPrice must be a finite number >= 0", "stopLossPrice");
      }
      if (p.takeProfitPrice !== undefined && (!Number.isFinite(p.takeProfitPrice) || p.takeProfitPrice < 0)) {
        throw new MexcValidationError("takeProfitPrice must be a finite number >= 0", "takeProfitPrice");
      }

      this.logger.info("🚀 Submitting order using /submit endpoint");

      this.logger.debug(
        "📦 Order parameters:",
        JSON.stringify(orderParams, null, 2)
      );

      // Generate headers with MEXC signature
      const headers = generateHeaders(
        this.getAuthOptions(),
        true,
        orderParams
      );

      const response = await this.httpClient.post(
        ENDPOINTS.SUBMIT_ORDER,
        orderParams,
        {
          headers,
        }
      );

      this.logger.debug("🔍 Order response:", response.data);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Submit a trigger (stop-entry) order using /api/v1/private/order/trigger/submit.
   * Used when a signal specifies an explicit entry price (@ or EP).
   * The order stays pending until the market price reaches triggerPrice.
   */
  async submitTriggerOrder(
    params: SubmitTriggerOrderRequest
  ): Promise<SubmitTriggerOrderResponse> {
    try {
      const p = params;
      if (!p || typeof p.symbol !== "string" || p.symbol.length === 0) {
        throw new MexcValidationError("symbol is required", "symbol");
      }
      if (!Number.isFinite(p.triggerPrice) || p.triggerPrice <= 0) {
        throw new MexcValidationError("triggerPrice must be a finite number > 0", "triggerPrice");
      }
      if (!Number.isFinite(p.price) || p.price < 0) {
        throw new MexcValidationError("price must be a finite number >= 0", "price");
      }
      if (!Number.isFinite(p.vol) || p.vol <= 0) {
        throw new MexcValidationError("vol must be a finite number > 0", "vol");
      }
      if (![1, 2, 3, 4].includes(p.side as number)) {
        throw new MexcValidationError("side must be one of 1,2,3,4", "side");
      }
      if (![1, 5].includes(p.type as number)) {
        throw new MexcValidationError("trigger type must be 1 (limit) or 5 (market)", "type");
      }
      if (![1, 2].includes(p.openType as number)) {
        throw new MexcValidationError("openType must be 1 (isolated) or 2 (cross)", "openType");
      }
      if (![1, 2].includes(p.triggerType as number)) {
        throw new MexcValidationError("triggerType must be 1 (latest price) or 2 (mark price)", "triggerType");
      }
      if (p.leverage !== undefined && (!Number.isFinite(p.leverage) || p.leverage <= 0)) {
        throw new MexcValidationError("leverage must be a finite number > 0", "leverage");
      }

      this.logger.info("🚀 Submitting trigger order using /trigger/submit endpoint");

      this.logger.debug(
        "📦 Trigger order parameters:",
        JSON.stringify(params, null, 2)
      );

      const headers = generateHeaders(
        this.getAuthOptions(),
        true,
        params
      );

      const response = await this.httpClient.post(
        ENDPOINTS.SUBMIT_TRIGGER_ORDER,
        params,
        { headers }
      );

      this.logger.debug("🔍 Trigger order response:", response.data);
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Submit a plan (stop/conditional) order using /api/v1/private/planorder/place/v2.
   * Used when a signal specifies an explicit entry price (@ or EP).
   * The order stays pending until the market price crosses the triggerPrice
   * in the specified direction.
   *
   * triggerType:
   *   1 = price >= triggerPrice  (buy stop  — triggers when price rises to EP)
   *   2 = price <= triggerPrice  (sell stop — triggers when price falls to EP)
   */
  async submitPlanOrder(
    params: SubmitPlanOrderRequest
  ): Promise<SubmitPlanOrderResponse> {
    try {
      const p = params;
      if (!p || typeof p.symbol !== "string" || p.symbol.length === 0) {
        throw new MexcValidationError("symbol is required", "symbol");
      }
      if (!Number.isFinite(p.triggerPrice) || p.triggerPrice <= 0) {
        throw new MexcValidationError("triggerPrice must be a finite number > 0", "triggerPrice");
      }
      if (![1, 2].includes(p.triggerType as number)) {
        throw new MexcValidationError("triggerType must be 1 (>=) or 2 (<=)", "triggerType");
      }
      if (![1, 2, 3, 4, 5].includes(p.orderType as number)) {
        throw new MexcValidationError("orderType must be 1..5", "orderType");
      }
      if (![1, 2].includes(p.executeCycle as number)) {
        throw new MexcValidationError("executeCycle must be 1 (24h) or 2 (7d)", "executeCycle");
      }
      if (![1, 2, 3].includes(p.trend as number)) {
        throw new MexcValidationError("trend must be 1 (latest), 2 (fair), or 3 (index)", "trend");
      }
      if (!Number.isFinite(p.vol) || p.vol <= 0) {
        throw new MexcValidationError("vol must be a finite number > 0", "vol");
      }
      if (![1, 2, 3, 4].includes(p.side as number)) {
        throw new MexcValidationError("side must be one of 1,2,3,4", "side");
      }
      if (![1, 2].includes(p.openType as number)) {
        throw new MexcValidationError("openType must be 1 (isolated) or 2 (cross)", "openType");
      }
      if (p.leverage !== undefined && (!Number.isFinite(p.leverage) || p.leverage <= 0)) {
        throw new MexcValidationError("leverage must be a finite number > 0", "leverage");
      }

      this.logger.info("🎯 Submitting plan order using /planorder/place/v2 endpoint");

      this.logger.debug(
        "📦 Plan order parameters:",
        JSON.stringify(params, null, 2)
      );

      const headers = generateHeaders(
        this.getAuthOptions(),
        true,
        params
      );

      const response = await this.httpClient.post(
        ENDPOINTS.SUBMIT_PLAN_ORDER,
        params,
        { headers }
      );

      this.logger.debug("🔍 Plan order response:", response.data);
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get pending plan orders — attached TP/SL orders AND stop/trigger entry
   * orders that have not yet fired.
   */
  async getPendingPlanOrders(): Promise<PendingPlanOrdersResponse> {
    try {
      const response = await this.httpClient.get(
        ENDPOINTS.GET_PENDING_PLAN_ORDERS
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Cancel orders by order IDs (up to 50 orders at once)
   */
  async cancelOrder(
    orderIds: Array<number | string | bigint>
  ): Promise<CancelOrderResponse> {
    try {
      if (orderIds.length === 0) {
        throw new MexcValidationError(
          "Order IDs array cannot be empty",
          "orderIds"
        );
      }
      if (orderIds.length > 50) {
        throw new MexcValidationError(
          "Cannot cancel more than 50 orders at once",
          "orderIds"
        );
      }

      // Serialize ids as strings: real MEXC order ids exceed 2^53 and cannot round-trip through a JS
      // number. Pass them through (string/bigint) and stringify so the signed body and the posted body
      // carry the exact id. The signature MUST be computed over the same payload that is sent.
      const ids = orderIds.map((id) => String(id));

      // Generate headers with MEXC signature for POST request
      const headers = generateHeaders(
        this.getAuthOptions(),
        true,
        ids
      );

      const response = await this.httpClient.post(
        ENDPOINTS.CANCEL_ORDER,
        ids,
        {
          headers,
        }
      );

      this.logger.debug("🔍 Cancel order response:", response.data);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Cancel order by external order ID
   */
  async cancelOrderByExternalId(
    params: CancelOrderByExternalIdRequest
  ): Promise<CancelOrderByExternalIdResponse> {
    try {
      // Generate headers with MEXC signature for POST request
      const headers = generateHeaders(
        this.getAuthOptions(),
        true,
        params
      );

      const response = await this.httpClient.post(
        ENDPOINTS.CANCEL_ORDER_BY_EXTERNAL_ID,
        params,
        {
          headers,
        }
      );

      this.logger.debug(
        "🔍 Cancel order by external ID response:",
        response.data
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Cancel all orders under a contract (or all orders if no symbol provided)
   */
  async cancelAllOrders(
    params?: CancelAllOrdersRequest
  ): Promise<CancelAllOrdersResponse> {
    try {
      const payload = params || {};

      // Generate headers with MEXC signature for POST request
      const headers = generateHeaders(
        this.getAuthOptions(),
        true,
        payload
      );

      const response = await this.httpClient.post(
        ENDPOINTS.CANCEL_ALL_ORDERS,
        payload,
        {
          headers,
        }
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get order history
   */
  async getOrderHistory(
    params: OrderHistoryParams
  ): Promise<OrderHistoryResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.ORDER_HISTORY, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get all transaction details of the user's orders
   */
  async getOrderDeals(params: OrderDealsParams): Promise<OrderDealsResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.ORDER_DEALS, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get order information by order ID
   * @param orderId Order ID to query
   * @returns Detailed order information
   */
  async getOrder(
    orderId: number | string | bigint
  ): Promise<GetOrderResponse> {
    try {
      const response = await this.httpClient.get(
        `${ENDPOINTS.GET_ORDER}/${encodeURIComponent(String(orderId))}`
      );
      this.logger.debug("🔍 Order response:", response.data);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get order information by external order ID
   * @param symbol Contract symbol (e.g., "BTC_USDT")
   * @param externalOid External order ID
   * @returns Detailed order information
   */
  async getOrderByExternalId(
    symbol: string,
    externalOid: string
  ): Promise<GetOrderResponse> {
    try {
      const response = await this.httpClient.get(
        `${ENDPOINTS.GET_ORDER_BY_EXTERNAL_ID}/${encodeURIComponent(symbol)}/${encodeURIComponent(externalOid)}`
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get risk limits for account
   */
  async getRiskLimit(): Promise<AccountResponse<RiskLimit[]>> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.RISK_LIMIT);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get fee rates for contracts
   */
  async getFeeRate(): Promise<AccountResponse<FeeRate[]>> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.FEE_RATE);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get user's single currency asset information
   * @param currency Currency symbol (e.g., "USDT", "BTC")
   * @returns Account asset information for the specified currency
   */
  async getAccountAsset(currency: string): Promise<AccountAssetResponse> {
    try {
      const response = await this.httpClient.get(
        `${ENDPOINTS.ACCOUNT_ASSET}/${encodeURIComponent(currency)}`
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get user's current holding positions
   * @param symbol Optional: specific contract symbol to filter positions
   * @returns List of open positions
   */
  async getOpenPositions(symbol?: string): Promise<OpenPositionsResponse> {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.httpClient.get(ENDPOINTS.OPEN_POSITIONS, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get user's history position information
   * @param params Parameters for filtering position history
   * @returns List of historical positions
   */
  async getPositionHistory(
    params: PositionHistoryParams
  ): Promise<PositionHistoryResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.POSITION_HISTORY, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get ticker data for a specific symbol
   */
  async getTicker(symbol: string): Promise<TickerResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.TICKER, {
        params: { symbol },
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get contract information
   * @param symbol Optional: specific contract symbol (e.g., "BTC_USDT"). If not provided, returns all contracts
   * @returns Contract details for specified symbol or all contracts
   */
  async getContractDetail(symbol?: string): Promise<ContractDetailResponse> {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.httpClient.get(ENDPOINTS.CONTRACT_DETAIL, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get contract's depth information (order book)
   * @param symbol Contract symbol (e.g., "BTC_USDT")
   * @param limit Optional: depth tier limit
   * @returns Order book with bids and asks
   */
  async getContractDepth(
    symbol: string,
    limit?: number
  ): Promise<ContractDepthResponse> {
    try {
      const params = limit ? { limit } : {};
      const response = await this.httpClient.get(
        `${ENDPOINTS.CONTRACT_DEPTH}/${encodeURIComponent(symbol)}`,
        { params }
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Test connection to the API (using public endpoint)
   */
  async testConnection(): Promise<boolean> {
    try {
      // Test with a common symbol
      await this.getTicker("BTC_USDT");
      return true;
    } catch (error) {
      // Error is already logged by the interceptor, just return false
      return false;
    }
  }
}
