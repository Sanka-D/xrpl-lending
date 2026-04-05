/**
 * Collateral deposit and withdrawal operations.
 */

import { AssetIndex } from "./types";
import type { LendingClient, TxResult } from "./client";
import {
  encodeU32LE,
  encodeU64LE,
  decodeBigintLE,
  userPositionKey,
} from "./client";
import { LendingClient as LC } from "./client";

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Deposit `amount` native units of `asset` as collateral.
 *
 * WASM: deposit_collateral(asset_id: u32, amount: u64)
 */
export async function depositCollateral(
  client: LendingClient,
  asset: AssetIndex,
  amount: bigint,
): Promise<TxResult> {
  const args = concat(encodeU32LE(asset), encodeU64LE(amount));
  return client.submitInvoke("deposit_collateral", args);
}

/**
 * Withdraw `amount` native units of collateral.
 * The contract enforces that HF remains ≥ 1.0 after withdrawal.
 *
 * WASM: withdraw_collateral(asset_id: u32, amount: u64)
 */
export async function withdrawCollateral(
  client: LendingClient,
  asset: AssetIndex,
  amount: bigint,
): Promise<TxResult> {
  const args = concat(encodeU32LE(asset), encodeU64LE(amount));
  return client.submitInvoke("withdraw_collateral", args);
}

// ── Read operations ───────────────────────────────────────────────────────────

/**
 * Read the user's collateral balance for one asset.
 *
 * State key: pos:{accountId 20 bytes}:{assetIndex}:co → u128 LE (16 bytes)
 */
export async function getCollateralBalance(
  client: LendingClient,
  account: string,
  asset: AssetIndex,
): Promise<bigint> {
  const accountId = LC.addressToAccountId(account);
  const key = userPositionKey(accountId, asset, "co");
  const raw = await client.readContractState(key);
  if (!raw || raw.length < 16) return 0n;
  return decodeBigintLE(raw.slice(0, 16));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
