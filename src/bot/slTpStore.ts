/**
 * Minimal in-memory store of SL/TP levels per contract symbol. Populated by
 * the bot when an order is placed and read by the summary monitor to evaluate
 * the >50%-toward-SL / >50%-toward-TP alert threshold.
 *
 * Also stores the fill order ID for each position so the summary (and the
 * CLOSE / REVERSE / ADD TO commands) can use it to identify the position.
 *
 * Entries are removed:
 *   - immediately when the position closes (via `remove()` called by the PNL monitor)
 *   - lazily pruned when older than `retentionDays` (as a safety net, called from
 *     the summary monitor's sample cycle)
 */
export class SlTpStore {
  private map = new Map<string, SlTpEntry>();

  set(symbol: string, entry: SlTpEntry): void {
    this.map.set(symbol, entry);
  }

  get(symbol: string): SlTpEntry | undefined {
    return this.map.get(symbol);
  }

  remove(symbol: string): void {
    this.map.delete(symbol);
  }

  /**
   * Get all entries. Used by the summary monitor to resolve fill order IDs.
   */
  entries(): IterableIterator<[string, SlTpEntry]> {
    return this.map.entries();
  }

  /**
   * Prune entries whose `setAt` timestamp is older than `maxAgeMs` milliseconds.
   * Called periodically from the summary monitor to prevent unlimited growth of
   * stale entries for positions that closed without triggering the onClose hook.
   */
  pruneStale(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [symbol, entry] of this.map) {
      if (entry.setAt < cutoff) {
        this.map.delete(symbol);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export interface SlTpEntry {
  /** Stop-loss price */
  sl: number;
  /** Take-profit price (nearest target for multi-TP signals) */
  tp: number;
  /** Position direction: 1 = long, 2 = short */
  positionType: 1 | 2;
  /** Unix ms when the entry was stored, used for retention-based pruning. */
  setAt: number;
  /** Fill order ID — use this for CLOSE / REVERSE / ADD TO commands. */
  orderId?: string;
}
