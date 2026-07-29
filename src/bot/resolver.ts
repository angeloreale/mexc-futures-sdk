import { MexcFuturesSDK } from "../client";
import { ContractDetail } from "../types/market";
import { Logger } from "../utils/logger";

/**
 * Resolves a candidate MEXC symbol against the exchange's contract list.
 * Caches the full contract list to avoid repeated API calls.
 */
export class ContractResolver {
  private client: MexcFuturesSDK;
  private logger: Logger;
  private contractCache: Map<string, ContractDetail> = new Map();
  private lastCacheRefresh = 0;
  private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(client: MexcFuturesSDK, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * Refresh the contract cache if stale.
   */
  async refreshIfNeeded(): Promise<void> {
    if (Date.now() - this.lastCacheRefresh < this.cacheTtlMs && this.contractCache.size > 0) {
      return;
    }

    this.logger.debug("🔄 Refreshing MEXC contract cache...");
    try {
      const response = await this.client.getContractDetail();
      const contracts = Array.isArray(response.data)
        ? response.data
        : [response.data];

      this.contractCache.clear();
      for (const contract of contracts) {
        if (contract && contract.symbol) {
          this.contractCache.set(contract.symbol, contract);
        }
      }
      this.lastCacheRefresh = Date.now();
      this.logger.info(
        `✅ Contract cache refreshed: ${this.contractCache.size} contracts`
      );
    } catch (error) {
      this.logger.error("❌ Failed to refresh contract cache:", error);
      throw error;
    }
  }

  /**
   * Resolve a MEXC-format symbol (e.g. "TAO_USDT") to its contract details.
   * Returns null if the symbol does not exist or is not tradable.
   */
  async resolve(mexcSymbol: string): Promise<ContractDetail | null> {
    await this.refreshIfNeeded();

    const contract = this.contractCache.get(mexcSymbol);
    if (!contract) {
      this.logger.warn(`⚠️ Symbol ${mexcSymbol} not found in MEXC contracts`);
      return null;
    }

    // Check contract is active (state 0 = enabled)
    if (contract.state !== 0) {
      this.logger.warn(
        `⚠️ Symbol ${mexcSymbol} is not active (state=${contract.state})`
      );
      return null;
    }

    // Check API trading is allowed
    if (!contract.apiAllowed) {
      this.logger.warn(
        `⚠️ Symbol ${mexcSymbol} does not allow API trading`
      );
      return null;
    }

    return contract;
  }

  /**
   * Check if a symbol exists in the cache at all.
   */
  async exists(mexcSymbol: string): Promise<boolean> {
    await this.refreshIfNeeded();
    return this.contractCache.has(mexcSymbol);
  }
}
