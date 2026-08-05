import { DEFAULT_HEADERS } from "./constants";
import md5 from "md5";
import * as crypto from "crypto";

export interface SDKOptions {
  /** MEXC API key (e.g. "mx0...") — preferred */
  apiKey?: string;
  /** MEXC API secret key — required with apiKey */
  secretKey?: string;
  /** WEB authentication token from browser (legacy, starts with "WEB...") */
  authToken?: string;
  userAgent?: string;
  customHeaders?: Record<string, string>; // Additional custom headers
}

/**
 * Generate MEXC crypto signature using the MD5 scheme.
 * NOTE: this is MEXC's server-dictated web-client signing scheme (reverse-engineered), not a
 * security control — MD5 is weak and the nonce is a millisecond timestamp. It cannot be changed
 * without breaking auth; treat the WEB `authToken` as the real bearer credential.
 * @param key WEB authentication key
 * @param obj Request object to sign
 * @returns Object with timestamp and signature
 */
function mexcCrypto(key: string, obj: any): { time: string; sign: string } {
  const dateNow = String(Date.now());
  const g = md5(key + dateNow).substring(7);
  const s = JSON.stringify(obj);
  const sign = md5(dateNow + s + g);

  return { time: dateNow, sign: sign };
}

/**
 * Generate HTTP headers for API requests.
 *
 * Supports two authentication modes:
 * 1. API Key + Secret Key (preferred): uses HMAC-SHA256 signing
 * 2. Browser WEB token (legacy): uses MD5-based signing
 *
 * Signature rules (MEXC Futures API v1):
 *   - POST:   sign `apiKey + timestamp + jsonBody`
 *   - GET/DELETE: sign `apiKey + timestamp + sortedQueryString`
 *     (business params sorted in dictionary order, joined with '&';
 *      use empty string when there are no params)
 */
export function generateHeaders(
  options: SDKOptions,
  includeAuth: boolean = true,
  requestBody?: any,
  queryParams?: Record<string, string | number | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
  };

  // Override user agent if provided
  if (options.userAgent) {
    headers["user-agent"] = options.userAgent;
  }

  // Add custom headers if provided
  if (options.customHeaders) {
    Object.assign(headers, options.customHeaders);
  }

  // Add authentication headers for private endpoints
  if (includeAuth) {
    if (options.apiKey && options.secretKey) {
      // --- API Key + Secret Key auth (HMAC-SHA256) ---
      headers["ApiKey"] = options.apiKey;
      const dateNow = String(Date.now());

      let signPayload: string;
      if (requestBody) {
        // POST: sign the JSON body (camelCase keys, no sorting)
        const bodyStr = typeof requestBody === "string"
          ? requestBody
          : JSON.stringify(requestBody);
        signPayload = options.apiKey + dateNow + bodyStr;
      } else {
        // GET/DELETE: sign the sorted query-string of business params
        // (empty string when there are no params)
        const queryStr = buildQueryString(queryParams);
        signPayload = options.apiKey + dateNow + queryStr;
      }

      const signature = crypto
        .createHmac("sha256", options.secretKey)
        .update(signPayload)
        .digest("hex");

      headers["Request-Time"] = dateNow;
      headers["Signature"] = signature;
    } else if (options.authToken) {
      // --- Legacy browser WEB token auth (MD5-based) ---
      headers["authorization"] = options.authToken;

      // Add MEXC signature for POST requests with body
      if (requestBody) {
        const signature = mexcCrypto(options.authToken, requestBody);

        headers["x-mxc-nonce"] = signature.time;
        headers["x-mxc-sign"] = signature.sign;
      }
    }
  }

  return headers;
}

/**
 * Build the MEXC GET/DELETE signature parameter string:
 * business params sorted in dictionary order and joined with '&'.
 * null/undefined values are omitted. Returns "" when there are no params.
 *
 * Values are percent-encoded with the same form-urlencoded encoding that
 * axios/URLSearchParams applies when it serializes `params` into the request
 * URL. This keeps the SIGNED string byte-for-byte identical to the query
 * string MEXC receives, which the server verifies the signature against.
 *
 * Critical case: comma-separated list params such as `states=1,3` for the
 * plan-order list endpoint. axios serializes the comma as `%2C` in the URL;
 * if the signature is computed over the raw `1,3`, MEXC rejects the request
 * with code 602 ("Confirming signature failed"). Encoding here fixes it.
 */
export function buildQueryString(
  params?: Record<string, string | number | undefined>
): string {
  if (!params) return "";
  const pairs: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    // Match URLSearchParams form-urlencoded encoding exactly: encodeURIComponent
    // plus the extra reserved chars that URLSearchParams percent-encodes.
    const encoded = encodeURIComponent(String(value)).replace(
      /[!'()*~]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
    );
    pairs.push(`${key}=${encoded}`);
  }
  return pairs.join("&");
}
