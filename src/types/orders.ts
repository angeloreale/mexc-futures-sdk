export interface OrderHistoryParams {
  category: number;
  page_num: number;
  page_size: number;
  states: number;
  symbol: string;
}

export interface Order {
  id: string | number; // large ids exceed 2^53 and are returned as exact strings; use String(id)
  symbol: string;
  side: number;
  type: string;
  vol: number;
  price: string;
  leverage: number;
  status: string;
  createTime: number;
  updateTime: number;
}

export interface OrderHistoryResponse {
  success: boolean;
  code: number;
  data: {
    orders: Order[];
    total: number;
  };
}

export interface OrderDealsParams {
  symbol: string;
  start_time?: number; // timestamp in milliseconds
  end_time?: number; // timestamp in milliseconds
  page_num: number;
  page_size: number;
}

export interface OrderDeal {
  id: number;
  symbol: string;
  side: number; // 1 open long, 2 close short, 3 open short, 4 close long
  vol: string; // transaction volume
  price: string; // transaction price
  fee: string; // fee amount
  feeCurrency: string; // fee currency
  profit: string; // profit
  isTaker: boolean; // is taker order
  category: number; // 1 limit order, 2 system take-over delegate, 3 close delegate, 4 ADL reduction
  orderId: string | number; // order id — large ids exceed 2^53 and are returned as exact strings; use String(orderId)
  timestamp: number; // transaction timestamp
}

export interface OrderDealsResponse {
  success: boolean;
  code: number;
  data: OrderDeal[];
}

// Cancel orders types
export interface CancelOrderResult {
  orderId: string | number; // large ids exceed 2^53 and are returned as exact strings; use String(orderId)
  errorCode: number; // 0 means success, non-zero means failure
  errorMsg: string;
}

export interface CancelOrderResponse {
  success: boolean;
  code: number;
  data: CancelOrderResult[];
}

export interface CancelOrderByExternalIdRequest {
  symbol: string;
  externalOid: string;
}

export interface CancelOrderByExternalIdResponse {
  success: boolean;
  code: number;
  data?: {
    symbol: string;
    externalOid: string;
  };
}

export interface CancelAllOrdersRequest {
  symbol?: string; // optional: cancel specific symbol orders, if not provided cancels all
}

export interface CancelAllOrdersResponse {
  success: boolean;
  code: number;
  data?: any;
}

// Submit order types (using /api/v1/private/order/submit endpoint)
export interface SubmitOrderRequest {
  symbol: string; // the name of the contract (mandatory)
  price: number; // price (mandatory)
  vol: number; // volume (mandatory)
  leverage?: number; // leverage, necessary on Isolated Margin (optional)
  side: 1 | 2 | 3 | 4; // order direction: 1=open long, 2=close short, 3=open short, 4=close long (mandatory)
  type: 1 | 2 | 3 | 4 | 5 | 6; // order type: 1=price limited order, 2=Post Only Maker, 3=transact or cancel instantly, 4=transact completely or cancel completely, 5=market orders, 6=convert market price to current price (mandatory)
  openType: 1 | 2; // open type: 1=isolated, 2=cross (mandatory)
  positionId?: number; // position ID, recommended when closing a position (optional)
  externalOid?: string; // external order ID (optional)
  stopLossPrice?: number; // stop-loss price (optional)
  takeProfitPrice?: number; // take-profit price (optional)
  positionMode?: 1 | 2; // position mode: 1=hedge, 2=one-way, default: user's current config (optional)
  reduceOnly?: boolean; // default false, for one-way positions to only reduce positions, two-way positions will not accept this parameter (optional)
}

export interface SubmitOrderResponse {
  success: boolean;
  code: number;
  message?: string;
  data?: string | number; // Order ID — large ids exceed 2^53 and are returned as exact strings; use String(data)
}

// ── Stop-Limit (TP/SL) Placement ─────────────────────────────────
// MEXC endpoint: POST /api/v1/private/stoporder/place
// Places a take-profit and/or stop-loss order against an EXISTING open
// position (identified by positionId). This is how MEXC supports LIMIT
// (maker) TP/SL: set takeProfitType/stopLossType = 1 and provide the
// takeProfitOrderPrice/stopLossOrderPrice limit price. When those *_type
// fields are omitted (or 0), the TP/SL executes as a market (taker) order.

export interface SubmitStopOrderRequest {
  /** Contract symbol (e.g. "BTC_USDT"). */
  symbol: string;
  /** Position ID of the open position to attach the TP/SL to. */
  positionId: number | string;
  /** Quantity (contracts) the TP/SL applies to. */
  vol: number;
  /** Stop-loss trigger price type: 1=latest (default), 2=fair, 3=index. */
  lossTrend?: 1 | 2 | 3;
  /** Take-profit trigger price type: 1=latest (default), 2=fair, 3=index. */
  profitTrend?: 1 | 2 | 3;
  /** Stop-loss trigger price. */
  stopLossPrice?: number;
  /** Stop-loss execution type: 0=market (default), 1=limit (maker). */
  stopLossType?: 0 | 1;
  /** Limit order price used when stopLossType=1. */
  stopLossOrderPrice?: number;
  /** Take-profit trigger price. */
  takeProfitPrice?: number;
  /** Take-profit execution type: 0=market (default), 1=limit (maker). */
  takeProfitType?: 0 | 1;
  /** Limit order price used when takeProfitType=1. */
  takeProfitOrderPrice?: number;
  /** TP/SL quantity type: "SAME" (shared vol, default) or "SEPARATE" (takeProfitVol/stopLossVol). */
  profitLossVolType?: "SAME" | "SEPARATE";
  /** Conditional-order trigger protection: 0 disabled (default), 1 enabled. */
  priceProtect?: 0 | 1;
}

export interface SubmitStopOrderResponse {
  success: boolean;
  code: number;
  message?: string;
  /** Stop-order ID — large ids exceed 2^53, use String(). */
  data?: string | number;
}

// ── Trigger (Plan) Order List ──────────────────────────────────────
// MEXC endpoint: GET /api/v1/private/planorder/list/orders
// Returns plan/trigger orders (stop entries). Filter with `states`:
// "1" = untriggered, "2" = cancelled, "3" = executed, "4" = invalid,
// "5" = execution failed. Multiple states separated by comma.

export interface PlanOrder {
  /** Trigger order ID — large ids exceed 2^53, use String(). */
  id: string | number;
  symbol: string;
  /** 1=open long, 2=close short, 3=open short, 4=close long */
  side: number;
  /** 1=more than or equal (>=), 2=less than or equal (<=) */
  triggerType: number;
  /** Price that triggers the order */
  triggerPrice: number | string;
  /** Execute price */
  price?: number | string;
  vol: number | string;
  openType?: 1 | 2;
  leverage?: number;
  /** 1 = untriggered, 2 = cancelled, 3 = executed, 4 = invalid, 5 = execution failed */
  state?: number;
  executeCycle?: number;
  trend?: number;
  orderType?: number;
  /** Order ID on successful execution (0 while untriggered) */
  orderId?: string | number;
  /** Stop-loss reference price type: 1=latest, 2=fair, 3=index */
  lossTrend?: number;
  /** Take-profit reference price type: 1=latest, 2=fair, 3=index */
  profitTrend?: number;
  /** Stop-loss price attached to the plan order */
  stopLossPrice?: number | string;
  /** Take-profit price attached to the plan order */
  takeProfitPrice?: number | string;
  errorCode?: number;
  priceProtect?: number;
  positionMode?: number;
  reduceOnly?: boolean;
  createTime?: number;
  updateTime?: number;
}

export interface PlanOrderListResponse {
  success: boolean;
  code: number;
  message?: string;
  data: any;
}

// ── Stop-Limit (TP/SL) Order List ──────────────────────────────────
// MEXC endpoint: GET /api/v1/private/stoporder/list/orders
// Returns attached TP/SL orders. Filter with `is_finished`: 0 = uncompleted,
// 1 = completed, or `state`: 1=untriggered, 2=cancelled, 3=executed,
// 4=invalidated, 5=execution failed. Each row carries BOTH the take-profit
// and stop-loss price for a position.

export interface StopOrder {
  /** Stop-Limit order ID — large ids exceed 2^53, use String(). */
  id: string | number;
  /** Limit order ID (0 when based on a position) */
  orderId?: string | number;
  symbol: string;
  positionId?: string | number;
  /** Stop-loss trigger type: 1=latest price, 2=fair price, 3=index price */
  lossTrend?: number;
  /** Take-profit trigger type: 1=latest price, 2=fair price, 3=index price */
  profitTrend?: number;
  stopLossPrice?: number | string;
  takeProfitPrice?: number | string;
  /** 1=untriggered, 2=cancelled, 3=executed, 4=invalidated, 5=execution failed */
  state?: number;
  /** 0=not triggered, 1=TP triggered, 2=SL triggered */
  triggerSide?: number;
  /** 1=long, 2=short */
  positionType: number;
  vol?: number | string;
  realityVol?: number | string;
  /** Order ID after successful placement */
  placeOrderId?: string | number;
  errorCode?: number;
  isFinished?: number;
  version?: number;
  priceProtect?: number;
  /** TP/SL quantity type: "SAME" or "SEPARATE" */
  profitLossVolType?: string;
  takeProfitVol?: number | string;
  stopLossVol?: number | string;
  createTime?: number;
  updateTime?: number;
  /** Quantity type: 1=partial TP/SL, 2=position TP/SL */
  volType?: number;
  takeProfitReverse?: number;
  stopLossReverse?: number;
  /** 0=market TP, 1=limit TP */
  takeProfitType?: number;
  takeProfitOrderPrice?: number | string;
  /** 0=market SL, 1=limit SL */
  stopLossType?: number;
  stopLossOrderPrice?: number | string;
}

export interface StopOrderListResponse {
  success: boolean;
  code: number;
  message?: string;
  /** Array of StopOrder objects, or wrapped in { resultList, orders, list } */
  data: StopOrder[] | { resultList?: StopOrder[]; orders?: StopOrder[]; list?: StopOrder[] };
}

// ── Trigger Order (Stop Entry) ────────────────────────────────────
// MEXC endpoint: POST /api/v1/private/order/trigger/submit
// Used when a signal specifies an explicit entry price (@ or EP).
// The order is placed as a pending trigger; it executes (market or limit)
// only when the market price reaches triggerPrice.

export interface SubmitTriggerOrderRequest {
  symbol: string;
  triggerType: 1 | 2; // 1=latest price trigger, 2=mark price trigger
  triggerPrice: number; // price that triggers the order
  price: number; // execution price (0 = market execution on trigger)
  vol: number;
  side: 1 | 2 | 3 | 4; // 1=open long, 2=close short, 3=open short, 4=close long
  type: 1 | 5; // execution type after trigger: 1=limit, 5=market
  openType: 1 | 2; // 1=isolated, 2=cross
  leverage?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  externalOid?: string;
}

export interface SubmitTriggerOrderResponse {
  success: boolean;
  code: number;
  message?: string;
  data?: string | number;
}

// ── Plan Order (Stop / Conditional Entry) ─────────────────────────
// MEXC endpoint: POST /api/v1/private/planorder/place/v2
// Used when a signal specifies an explicit entry price (@ or EP).
// The order is placed as a pending plan (stop/conditional); it executes
// only when the market price crosses the triggerPrice in the specified
// direction.
//
// triggerType:
//   1 = price >= triggerPrice  (buy stop  — triggers when price rises to EP)
//   2 = price <= triggerPrice  (sell stop — triggers when price falls to EP)
//
// executeCycle: 1 = 24 hours, 2 = 7 days
// trend: 1 = latest price, 2 = fair price, 3 = index price

export interface SubmitPlanOrderRequest {
  symbol: string;
  triggerPrice: number;
  triggerType: 1 | 2; // 1=price >= triggerPrice, 2=price <= triggerPrice
  orderType: 1 | 2 | 3 | 4 | 5; // 1=limit, 2=Post Only, 3=IOC, 4=FOK, 5=market
  executeCycle: 1 | 2; // 1=24 hours, 2=7 days
  trend: 1 | 2 | 3; // 1=latest price, 2=fair price, 3=index price
  price?: number; // execution price (not required for market orderType=5)
  vol: number;
  leverage: number;
  side: 1 | 2 | 3 | 4; // 1=open long, 2=close short, 3=open short, 4=close long
  openType: 1 | 2; // 1=isolated, 2=cross
  stopLossPrice?: number;
  takeProfitPrice?: number;
  externalOid?: string;
  positionMode?: 1 | 2;
  lossTrend?: 1 | 2 | 3;
  profitTrend?: 1 | 2 | 3;
  priceProtect?: 0 | 1;
  reduceOnly?: boolean;
}

export interface SubmitPlanOrderResponse {
  success: boolean;
  code: number;
  message?: string;
  data?: string | number;
}

// Get order by ID types
export interface GetOrderResponse {
  success: boolean;
  code: number;
  data: {
    orderId: string | number; // large ids exceed 2^53 and are returned as exact strings; use String(orderId)
    symbol: string;
    positionId: number;
    price: number;
    vol: number;
    leverage: number;
    side: number; // 1 open long, 2 close short, 3 open short, 4 close long
    category: number; // 1 limit order, 2 system take-over delegate, 3 close delegate, 4 ADL reduction
    orderType: number; // 1:price limited order,2:Post Only Maker,3:transact or cancel instantly ,4 : transact completely or cancel completely，5:market orders,6 convert market price to current price
    dealAvgPrice: number;
    dealVol: number;
    orderMargin: number;
    takerFee: number;
    makerFee: number;
    profit: number;
    feeCurrency: string;
    openType: number; // 1 isolated, 2 cross
    state: number; // 1 uninformed, 2 uncompleted, 3 completed, 4 cancelled, 5 invalid
    externalOid: string;
    errorCode: number;
    usedMargin: number;
    createTime: number;
    updateTime: number;
  };
}
