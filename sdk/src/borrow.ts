/**
 * Borrow and repay operations.
 */

import { AssetIndex } from "./types";
import type { LendingClient, TxResult } from "./client";
import {
  encodeU32LE,
  encodeU64LE,
  decodeBigintLE,
  marketInterestKey,
  userPositionKey,
} from "./client";
import { LendingClient as LC } from "./client";
import { getActualDebt } from "./health";

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Borrow `amount` native units of `asset` from the lending pool.
 *
 * WASM: borrow(asset_id: u32, amount: u64)
 */
export async function borrow(
  client: LendingClient,
  asset: AssetIndex,
  amount: bigint,
): Promise<TxResult> {
  const args = concat(encodeU32LE(asset), encodeU64LE(amount));
  return client.submitInvoke("borrow", args);
}

/**
 * Repay `amount` native units of debt for `asset`.
 * Overpayment is automatically refunded by the contract.
 *
 * WASM: repay(asset_id: u32, amount: u64)
 */
export async function repay(
  client: LendingClient,
  asset: AssetIndex,
  amount: bigint,
): Promise<TxResult> {
  const args = concat(encodeU32LE(asset), encodeU64LE(amount));
  return client.submitInvoke("repay", args);
}

// ── Read operations ───────────────────────────────────────────────────────────

/**
 * Read the current debt balance (with accrued interest) for a user in one market.
 *
 * Reads:
 *   pos:{id}:{asset}:de  — stored principal (u128 LE)
 *   pos:{id}:{asset}:bi  — user's borrow index snapshot (u128 LE)
 *   mkt:{asset}:int:bi   — current global borrow index (u128 LE)
 *
 * Applies interest: actual_debt = principal × currentIndex / userIndex
 */
export async function getDebtBalance(
  client: LendingClient,
  account: string,
  asset: AssetIndex,
): Promise<bigint> {
  const accountId = LC.addressToAccountId(account);

  const [rawPrincipal, rawUserIndex, rawCurrentIndex] = await Promise.all([
    client.readContractState(userPositionKey(accountId, asset, "de")),
    client.readContractState(userPositionKey(accountId, asset, "bi")),
    client.readContractState(marketInterestKey(asset, "bi")),
  ]);

  const principal = rawPrincipal ? decodeBigintLE(rawPrincipal) : 0n;
  if (principal === 0n) return 0n;

  const userBorrowIndex = rawUserIndex ? decodeBigintLE(rawUserIndex) : 10n ** 18n;
  const currentBorrowIndex = rawCurrentIndex ? decodeBigintLE(rawCurrentIndex) : 10n ** 18n;

  return getActualDebt(principal, userBorrowIndex, currentBorrowIndex);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
