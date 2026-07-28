import * as fs from "fs";
import * as path from "path";
import { Logger } from "../utils/logger";

/**
 * Simple JSON-file-backed state for processed message idempotency.
 * Tracks which Telegram message IDs have already been processed
 * so the bot can restart without replaying old signals.
 */
export class BotState {
  private filePath: string;
  private logger: Logger;
  private processed: Set<string> = new Set();
  private maxEntries = 10000;

  constructor(filePath: string, logger: Logger) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
    this.load();
  }

  /**
   * Build a unique key for a message.
   */
  private messageKey(chatId: number | string, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  /**
   * Check if a message has already been processed.
   */
  isProcessed(chatId: number | string, messageId: number): boolean {
    return this.processed.has(this.messageKey(chatId, messageId));
  }

  /**
   * Mark a message as processed and persist.
   */
  markProcessed(chatId: number | string, messageId: number): void {
    this.processed.add(this.messageKey(chatId, messageId));

    // Evict oldest entries if the set gets too large
    if (this.processed.size > this.maxEntries) {
      const entries = Array.from(this.processed);
      const toRemove = entries.slice(0, entries.length - this.maxEntries);
      for (const key of toRemove) {
        this.processed.delete(key);
      }
    }

    this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.processed)) {
          this.processed = new Set(data.processed);
          this.logger.info(
            `📂 Loaded ${this.processed.size} processed message IDs from state`
          );
        }
      }
    } catch (error) {
      this.logger.warn("⚠️ Could not load bot state file — starting fresh");
    }
  }

  private save(): void {
    try {
      const data = {
        processed: Array.from(this.processed),
        updatedAt: new Date().toISOString(),
      };
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(data), "utf-8");
    } catch (error) {
      this.logger.error("❌ Failed to persist bot state:", error);
    }
  }
}
