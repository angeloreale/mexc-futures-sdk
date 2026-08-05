#!/usr/bin/env node

/**
 * CLI entrypoint for the MEXC Telegram Signal Bot.
 *
 * Usage:
 *   npx ts-node src/bot/index.ts
 *   node dist/bot/index.js
 *
 * Requires environment variables — see .env.example for the full list.
 */

// Load .env file if present (devDependency — gracefully skip if missing)
try {
  require("dotenv").config();
} catch {
  // dotenv is optional in production
}

import { loadConfig } from "./config";
import { SignalBot } from "./bot";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════");
  console.log("  Dupip Crypto Connector");
  console.log("═══════════════════════════════════════════");

  try {
    const config = loadConfig();
    const bot = new SignalBot(config);
    await bot.start();
  } catch (error) {
    console.error(
      "❌ Fatal error:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

main();
