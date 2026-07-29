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
 */
export function generateHeaders(
  options: SDKOptions,
  includeAuth: boolean = true,
  requestBody?: any
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

      if (requestBody) {
        const dateNow = String(Date.now());
        const bodyStr = typeof requestBody === "string"
          ? requestBody
          : JSON.stringify(requestBody);
        const signPayload = options.apiKey + dateNow + bodyStr;
        const signature = crypto
          .createHmac("sha256", options.secretKey)
          .update(signPayload)
          .digest("hex");

        headers["Request-Time"] = dateNow;
        headers["Signature"] = signature;
      } else {
        // For GET requests, sign with just apiKey + timestamp
        const dateNow = String(Date.now());
        const signature = crypto
          .createHmac("sha256", options.secretKey)
          .update(options.apiKey + dateNow)
          .digest("hex");

        headers["Request-Time"] = dateNow;
        headers["Signature"] = signature;
      }
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
