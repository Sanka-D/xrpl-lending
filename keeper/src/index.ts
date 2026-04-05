#!/usr/bin/env node
/**
 * XRPL Lending Protocol — Liquidation Keeper
 *
 * Pipeline (each XRPL ledger close, ~3-5s):
 *   OracleWatcher → Monitor.scan → filterProfitable → Liquidator.executeBatch
 *
 * Usage:
 *   ts-node src/index.ts [--dry-run]
 *
 * Environment variables:
 *   KEEPER_WALLET_SECRET  — signing wallet seed
 *   CONTROLLER_ADDRESS    — contract r-address
 *   MONITORED_ACCOUNTS    — comma-separated accounts to watch
 *   See config.ts for full list.
 */

import { Wallet } from "xrpl";
import { LendingClient } from "xrpl-lending-sdk";
import { loadConfig } from "./config";
import { OracleWatcher } from "./oracle-watcher";
import { PositionMonitor } from "./monitor";
import { filterProfitable } from "./profitability";
import { Liquidator } from "./liquidator";
import { log, formatWadUsd } from "./logger";
import type { PriceUpdate } from "./oracle-watcher";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig(args);

  log("INFO", "XRPL Lending Keeper starting", {
    wsUrl: config.wsUrl,
    controllerAddress: config.controllerAddress,
    monitoredAccounts: config.monitoredAccounts.length,
    dryRun: config.dryRun,
    minProfitUsd: formatWadUsd(config.minProfitUsd),
    gasCostDrops: config.liquidationGasCostDrops.toString(),
  });

  // ── Wallet ──────────────────────────────────────────────────────────────────

  const wallet = config.walletSecret ? Wallet.fromSeed(config.walletSecret) : undefined;
  if (wallet) {
    log("INFO", `Keeper wallet: ${wallet.classicAddress}`);
  } else {
    log("INFO", "No wallet configured — dry-run only");
  }

  // ── XRPL client ─────────────────────────────────────────────────────────────

  const lendingClient = new LendingClient({
    wsUrl: config.wsUrl,
    contractAddress: config.controllerAddress,
    wallet,
  });

  await lendingClient.connect();
  log("INFO", "Connected to XRPL node");

  // ── Components ──────────────────────────────────────────────────────────────

  const monitor = new PositionMonitor(lendingClient, {
    initialAccounts: config.monitoredAccounts,
  });

  const liquidator = new Liquidator(lendingClient, {
    dryRun: config.dryRun,
    cooldownMs: config.liquidationCooldownMs,
  });

  // ── Pipeline callback ────────────────────────────────────────────────────────

  const onPriceUpdate = async (update: PriceUpdate): Promise<void> => {
    log("INFO", `Ledger ${update.ledgerIndex} — prices updated`, {
      XRP: formatWadUsd(update.pricesByIndex[0] ?? 0n),
      RLUSD: formatWadUsd(update.pricesByIndex[1] ?? 0n),
      wBTC: formatWadUsd(update.pricesByIndex[2] ?? 0n),
    });

    // Scan for liquidatable positions
    let opportunities;
    try {
      opportunities = await monitor.scan();
    } catch (err) {
      log("ERROR", "Monitor scan failed", { error: String(err) });
      return;
    }

    if (opportunities.length === 0) {
      log("INFO", "No liquidatable positions found");
      return;
    }

    log("INFO", `Found ${opportunities.length} liquidatable position(s)`);

    // Filter by profitability
    const profitable = filterProfitable(opportunities, update.pricesByIndex, {
      minProfitUsd: config.minProfitUsd,
      liquidationGasCostDrops: config.liquidationGasCostDrops,
    });

    if (profitable.length === 0) {
      log("INFO", "No opportunities above profit threshold", {
        threshold: formatWadUsd(config.minProfitUsd),
      });
      return;
    }

    log("INFO", `${profitable.length} profitable opportunity(ies)`, {
      best: formatWadUsd(profitable[0].netProfitUsd),
    });

    // Execute liquidations
    const results = await liquidator.executeBatch(profitable);

    // Summary log
    const succeeded = results.filter(r => r.success && !r.skippedReason).length;
    const skipped = results.filter(r => r.skippedReason).length;
    const failed = results.filter(r => !r.success && !r.skippedReason).length;

    log("INFO", "Batch complete", { succeeded, skipped, failed });
  };

  // ── Oracle watcher ───────────────────────────────────────────────────────────

  const watcher = new OracleWatcher(lendingClient, onPriceUpdate);
  await watcher.start();

  log("INFO", `Keeper running. Watching ${config.monitoredAccounts.length} accounts. Dry-run: ${config.dryRun}`);
  if (config.dryRun) {
    log("WARN", "DRY-RUN mode: liquidations will be logged but NOT submitted");
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    log("INFO", "Received shutdown signal, stopping...");
    await watcher.stop();
    await lendingClient.disconnect();
    log("INFO", "Keeper stopped cleanly");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  log("ERROR", "Fatal startup error", { error: String(err) });
  process.exit(1);
});
