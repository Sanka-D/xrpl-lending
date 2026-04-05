/**
 * Keeper bot configuration.
 * Protocol constants are hardcoded; tunable thresholds come from environment variables.
 */

import * as dotenv from "dotenv";
import { WAD, AssetIndex } from "xrpl-lending-sdk";

// ── Protocol constants ────────────────────────────────────────────────────────

/** Default XRPL AlphaNet WebSocket URL */
export const ALPHANET_WSS = "wss://s.devnet.rippletest.net:51233";

/** DIA oracle constants (mirror of Rust state.rs) */
export const DIA_ACCOUNT = "rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7";
export const ORACLE_DOC_ID = 42;

/** V1 asset list */
export const ASSETS = [AssetIndex.XRP, AssetIndex.RLUSD, AssetIndex.WBTC] as const;

/**
 * Token details for RLUSD and wBTC trustlines.
 * Used when checking keeper wallet token balances.
 */
export const ASSET_TOKEN_INFO: Record<number, { currency: string; issuer: string } | null> = {
  [AssetIndex.XRP]: null,     // native, no trustline
  [AssetIndex.RLUSD]: { currency: "524C555344000000000000000000000000000000", issuer: "" }, // placeholder
  [AssetIndex.WBTC]: { currency: "7742544300000000000000000000000000000000", issuer: "" }, // placeholder
};

/** XRP drops to keep as minimum reserve (account reserve ~10 XRP + fee buffer) */
export const XRP_RESERVE_DROPS = 10_000_000n; // 10 XRP

// ── Config interface ──────────────────────────────────────────────────────────

export interface KeeperConfig {
  /** WebSocket URL */
  wsUrl: string;
  /** r-address of the lending controller contract */
  controllerAddress: string;
  /** Wallet seed (undefined if dry-run only) */
  walletSecret: string | undefined;
  /** Minimum net profit to execute a liquidation, WAD-scaled USD */
  minProfitUsd: bigint;
  /** Estimated cost per tx in XRP drops */
  liquidationGasCostDrops: bigint;
  /** Accounts to monitor (r-addresses) */
  monitoredAccounts: string[];
  /** If true: log opportunities but do not submit transactions */
  dryRun: boolean;
  /** Minimum milliseconds between consecutive liquidation submissions */
  liquidationCooldownMs: number;
}

// ── loadConfig ────────────────────────────────────────────────────────────────

/**
 * Load configuration from environment variables and CLI arguments.
 *
 * Environment variables:
 *   KEEPER_WALLET_SECRET      — signing wallet seed (required unless --dry-run)
 *   CONTROLLER_ADDRESS        — lending controller r-address (required)
 *   MONITORED_ACCOUNTS        — comma-separated r-addresses to watch
 *   XRPL_WSS_URL              — WebSocket URL (default: ALPHANET_WSS)
 *   MIN_PROFIT_USD            — minimum net profit in USD, integer (default: 10)
 *   LIQUIDATION_GAS_DROPS     — estimated tx gas in drops (default: 12)
 *   LIQUIDATION_COOLDOWN_MS   — cooldown between txs in ms (default: 4000)
 *
 * CLI flags:
 *   --dry-run                 — log opportunities, do not execute
 */
export function loadConfig(args: string[] = []): KeeperConfig {
  dotenv.config();

  const dryRun = args.includes("--dry-run");

  const walletSecret = process.env.KEEPER_WALLET_SECRET?.trim() || undefined;
  if (!walletSecret && !dryRun) {
    throw new Error(
      "KEEPER_WALLET_SECRET must be set, or pass --dry-run to run without executing.",
    );
  }

  const controllerAddress = process.env.CONTROLLER_ADDRESS?.trim();
  if (!controllerAddress) {
    throw new Error("CONTROLLER_ADDRESS environment variable is required.");
  }

  const rawAccounts = process.env.MONITORED_ACCOUNTS?.trim();
  const monitoredAccounts = rawAccounts
    ? rawAccounts.split(",").map(a => a.trim()).filter(Boolean)
    : [];

  if (monitoredAccounts.length === 0) {
    console.warn("[WARN] MONITORED_ACCOUNTS is empty — no positions will be monitored.");
  }

  const minProfitUsdInt = parseInt(process.env.MIN_PROFIT_USD ?? "10", 10);
  const gasCostDropsInt = parseInt(process.env.LIQUIDATION_GAS_DROPS ?? "12", 10);
  const cooldownMs = parseInt(process.env.LIQUIDATION_COOLDOWN_MS ?? "4000", 10);

  return {
    wsUrl: process.env.XRPL_WSS_URL?.trim() ?? ALPHANET_WSS,
    controllerAddress,
    walletSecret,
    minProfitUsd: BigInt(minProfitUsdInt) * WAD,
    liquidationGasCostDrops: BigInt(gasCostDropsInt),
    monitoredAccounts,
    dryRun,
    liquidationCooldownMs: cooldownMs,
  };
}
