/**
 * Shared utilities for all deploy scripts.
 * Loads config from environment, reads/writes deployed.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config as loadDotenv } from "dotenv";
import { Wallet } from "xrpl";

// Load .env from repo root (one level up from deploy/)
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env"), override: false });

// ── Constants ─────────────────────────────────────────────────────────────────

export const ALPHANET_WSS = "wss://alphanet.nerdnest.xyz";
export const DEPLOYED_STATE_FILE = resolve(__dirname, "deployed.json");
export const WASM_PATH = resolve(
  __dirname,
  "../contracts/lending-controller/target/wasm32-unknown-unknown/release/lending_controller.wasm",
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VaultIds {
  XRP?: string;
  RLUSD?: string;
  WBTC?: string;
}

export interface DeployedState {
  /** XRPL WebSocket URL used for this deployment */
  network: string;
  /** r-address of the deployer account */
  deployer: string;
  /** ISO timestamp of deployment */
  timestamp: string;
  /** VaultIDs of the three supply vaults (hex ledger index) */
  vaultIds: VaultIds;
  /** r-address / pseudo-account of the deployed lending controller */
  controllerAddress?: string;
  /** Vault accounts registered in contract global state */
  vaultAccounts?: { XRP?: string; RLUSD?: string; WBTC?: string };
  /** r-address of the RLUSD token issuer on this network */
  rlusdIssuer?: string;
  /** r-address of the wBTC token issuer on this network */
  wbtcIssuer?: string;
}

// ── Config loading ────────────────────────────────────────────────────────────

export interface DeployEnv {
  wsUrl: string;
  deployerSecret: string;
  rlusdIssuer: string;
  wbtcIssuer: string;
}

export function loadDeployEnv(): DeployEnv {
  const deployerSecret = process.env.DEPLOYER_SECRET;
  if (!deployerSecret) {
    throw new Error("Missing env var: DEPLOYER_SECRET");
  }
  return {
    wsUrl: process.env.XRPL_WSS_URL ?? ALPHANET_WSS,
    deployerSecret,
    rlusdIssuer: process.env.RLUSD_ISSUER ?? "",
    wbtcIssuer: process.env.WBTC_ISSUER ?? "",
  };
}

// ── State persistence ─────────────────────────────────────────────────────────

export function loadDeployedState(): DeployedState | null {
  if (!existsSync(DEPLOYED_STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(DEPLOYED_STATE_FILE, "utf-8")) as DeployedState;
  } catch {
    return null;
  }
}

export function saveDeployedState(state: DeployedState): void {
  writeFileSync(DEPLOYED_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  log(`Saved deployment state to ${DEPLOYED_STATE_FILE}`);
}

// ── Logging ───────────────────────────────────────────────────────────────────

export function log(msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] ${msg}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${ts}] ${msg}`);
  }
}

/**
 * Create the deployer wallet from a seed.
 * Defaults to ecdsa-secp256k1 (required for the Bedrock genesis account).
 * Set DEPLOYER_KEY_TYPE=ed25519 to override.
 */
export function loadDeployWallet(secret: string): Wallet {
  const algo = (process.env.DEPLOYER_KEY_TYPE ?? "ecdsa-secp256k1") as "ecdsa-secp256k1" | "ed25519";
  return Wallet.fromSeed(secret, { algorithm: algo });
}

export function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

// ── Transaction helpers ───────────────────────────────────────────────────────

/** Extract a created ledger object's index from transaction metadata. */
export function extractCreatedNodeIndex(
  meta: unknown,
  ledgerEntryType: string,
): string | undefined {
  const m = meta as Record<string, unknown>;
  const nodes = (m?.AffectedNodes as unknown[]) ?? [];
  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    const created = n?.CreatedNode as Record<string, unknown> | undefined;
    if (created?.LedgerEntryType === ledgerEntryType) {
      return created?.LedgerIndex as string | undefined;
    }
  }
  return undefined;
}

/** Extract a created account address from transaction metadata. */
export function extractCreatedAccount(meta: unknown): string | undefined {
  const m = meta as Record<string, unknown>;
  const nodes = (m?.AffectedNodes as unknown[]) ?? [];
  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    const created = n?.CreatedNode as Record<string, unknown> | undefined;
    if (created?.LedgerEntryType === "AccountRoot") {
      const nf = created?.NewFields as Record<string, unknown> | undefined;
      return nf?.Account as string | undefined;
    }
  }
  return undefined;
}

/** Convert a hex string to uppercase with no prefix. */
export function toUpperHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
}
