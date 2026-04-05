/**
 * Supply (lending) operations: deposit into vault, withdraw shares, read balances.
 */

import { AssetIndex } from "./types";
import type { InterestState } from "./types";
import type { LendingClient, TxResult } from "./client";
import {
  encodeU32LE,
  encodeU64LE,
  decodeBigintLE,
  marketInterestKey,
  userPositionKey,
} from "./client";
import { LendingClient as LC } from "./client";

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Supply `amount` native units of `asset` into the lending vault.
 *
 * WASM: supply(asset_id: u32, amount: u64)
 * args = encodeU32LE(asset) ++ encodeU64LE(amount)  (12 bytes)
 */
export async function supply(
  client: LendingClient,
  asset: AssetIndex,
  amount: bigint,
): Promise<TxResult> {
  const args = concat(encodeU32LE(asset), encodeU64LE(amount));
  return client.submitInvoke("supply", args);
}

/**
 * Withdraw `shares` supply shares from the lending vault, redeeming underlying assets.
 *
 * WASM: withdraw(asset_id: u32, shares: u64)
 */
export async function withdraw(
  client: LendingClient,
  asset: AssetIndex,
  shares: bigint,
): Promise<TxResult> {
  const args = concat(encodeU32LE(asset), encodeU64LE(shares));
  return client.submitInvoke("withdraw", args);
}

// ── Read operations ───────────────────────────────────────────────────────────

/**
 * Read the user's current supply shares for one asset.
 *
 * State key: pos:{accountId 20 bytes}:{assetIndex}:sh → u128 LE (16 bytes)
 */
export async function getSupplyShares(
  client: LendingClient,
  account: string,
  asset: AssetIndex,
): Promise<bigint> {
  const accountId = LC.addressToAccountId(account);
  const key = userPositionKey(accountId, asset, "sh");
  const raw = await client.readContractState(key);
  if (!raw || raw.length < 16) return 0n;
  return decodeBigintLE(raw.slice(0, 16));
}

/**
 * Read the full interest state for one market.
 *
 * Reads 7 state keys in parallel:
 *   mkt:{i}:int:br  (borrow_rate_bps, u64)
 *   mkt:{i}:int:sr  (supply_rate_bps, u64)
 *   mkt:{i}:int:bi  (borrow_index,    u128)
 *   mkt:{i}:int:si  (supply_index,    u128)
 *   mkt:{i}:int:ts  (last_update_timestamp, u64)
 *   mkt:{i}:int:tb  (total_borrows,   u128)
 *   mkt:{i}:int:tp  (total_supply,    u128)
 */
export async function getInterestState(
  client: LendingClient,
  asset: AssetIndex,
): Promise<InterestState> {
  const fields = ["br", "sr", "bi", "si", "ts", "tb", "tp"] as const;
  const keys = fields.map(f => marketInterestKey(asset, f));
  const values = await Promise.all(keys.map(k => client.readContractState(k)));

  const [rawBr, rawSr, rawBi, rawSi, rawTs, rawTb, rawTp] = values;

  return {
    assetIndex: asset,
    borrowRateBps: rawBr ? Number(decodeBigintLE(rawBr)) : 0,
    supplyRateBps: rawSr ? Number(decodeBigintLE(rawSr)) : 0,
    borrowIndex: rawBi ? decodeBigintLE(rawBi) : 10n ** 18n,
    supplyIndex: rawSi ? decodeBigintLE(rawSi) : 10n ** 18n,
    lastUpdateTimestamp: rawTs ? Number(decodeBigintLE(rawTs)) : 0,
    totalBorrows: rawTb ? decodeBigintLE(rawTb) : 0n,
    totalSupply: rawTp ? decodeBigintLE(rawTp) : 0n,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
