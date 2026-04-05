/**
 * Client-side health factor and liquidation math.
 * Pure bigint functions — no network calls, mirrors Rust health.rs exactly.
 */

import { WAD, BPS, AssetIndex } from "./types";
import type { UserPositionForAsset, MarketConfig } from "./types";

// ── Constants ──────────────────────────────────────────────────────────────────

export const ASSET_DECIMALS: readonly [number, number, number] = [6, 6, 8];

const NUM_MARKETS = 3;

/** Precomputed powers of 10 for decimal scaling. */
const POW10: bigint[] = Array.from({ length: 38 }, (_, i) => 10n ** BigInt(i));

/** u128::MAX equivalent — returned as HF when there is no debt. */
export const HF_MAX = 2n ** 128n - 1n;

// ── Core math ──────────────────────────────────────────────────────────────────

/**
 * USD value of a native-unit amount.
 *
 * Mirrors Rust `asset_usd_value`: divides price by 10^decimals first to stay
 * within bounds before multiplying by amount.
 *
 *   price_per_native = priceWad / 10^decimals
 *   result           = amountNative × price_per_native
 */
export function assetUsdValue(
  amountNative: bigint,
  priceWad: bigint,
  decimals: number,
): bigint {
  const pricePerNative = priceWad / POW10[decimals];
  return amountNative * pricePerNative;
}

/**
 * Actual debt with accrued interest.
 *
 *   actual_debt = principal × currentBorrowIndex / userBorrowIndex
 *
 * Mirrors Rust `get_actual_debt`.
 */
export function getActualDebt(
  principal: bigint,
  userBorrowIndex: bigint,
  currentBorrowIndex: bigint,
): bigint {
  if (userBorrowIndex === 0n) return 0n;
  return (principal * currentBorrowIndex) / userBorrowIndex;
}

/**
 * Health factor (WAD-scaled).
 *
 *   HF = Σ(collateral_i × price_i × liqThreshold_i / BPS) / Σ(debt_i × price_i)
 *
 * Returns HF_MAX when there is no debt.
 * Mirrors Rust `calculate_health_factor`.
 */
export function calculateHealthFactor(
  positions: UserPositionForAsset[],
  prices: bigint[],
  configs: MarketConfig[],
): bigint {
  let totalWeightedCollateral = 0n;
  let totalDebtUsd = 0n;

  for (let i = 0; i < NUM_MARKETS; i++) {
    const pos = positions[i];
    const price = prices[i];
    const config = configs[i];

    if (pos.collateral > 0n) {
      const colUsd = assetUsdValue(pos.collateral, price, ASSET_DECIMALS[i]);
      totalWeightedCollateral += (colUsd * BigInt(config.liquidationThreshold)) / BPS;
    }

    if (pos.debt > 0n) {
      totalDebtUsd += assetUsdValue(pos.debt, price, ASSET_DECIMALS[i]);
    }
  }

  if (totalDebtUsd === 0n) return HF_MAX;
  return (totalWeightedCollateral * WAD) / totalDebtUsd;
}

/**
 * Remaining borrow capacity in USD (WAD-scaled), saturating to 0.
 *
 *   capacity = Σ(col × price × ltv / BPS) - Σ(debt × price)
 *
 * Mirrors Rust `calculate_borrow_capacity`.
 */
export function calculateBorrowCapacity(
  positions: UserPositionForAsset[],
  prices: bigint[],
  configs: MarketConfig[],
): bigint {
  let totalLtvCollateral = 0n;
  let totalDebtUsd = 0n;

  for (let i = 0; i < NUM_MARKETS; i++) {
    const pos = positions[i];
    const price = prices[i];
    const config = configs[i];

    if (pos.collateral > 0n) {
      const colUsd = assetUsdValue(pos.collateral, price, ASSET_DECIMALS[i]);
      totalLtvCollateral += (colUsd * BigInt(config.ltv)) / BPS;
    }

    if (pos.debt > 0n) {
      totalDebtUsd += assetUsdValue(pos.debt, price, ASSET_DECIMALS[i]);
    }
  }

  if (totalLtvCollateral <= totalDebtUsd) return 0n;
  return totalLtvCollateral - totalDebtUsd;
}

/**
 * Whether a position is liquidatable (HF < 1.0 WAD).
 */
export function isLiquidatable(healthFactor: bigint): boolean {
  return healthFactor < WAD;
}

/**
 * Maximum debt repayable in a single liquidation call (50% close factor).
 *
 * Mirrors Rust `calculate_max_liquidation`.
 */
export function calculateMaxLiquidation(totalDebtUsd: bigint): bigint {
  return (totalDebtUsd * 5000n) / 10000n;
}

/**
 * Collateral seized for repaying a given native debt amount.
 *
 * Returns { collateralToSeize, bonus } both in native units of the collateral asset.
 *
 * Mirrors Rust `calculate_liquidation_amounts`.
 */
export function calculateLiquidationAmounts(params: {
  debtToRepayNative: bigint;
  debtPriceWad: bigint;
  collateralPriceWad: bigint;
  liquidationBonusBps: number;
  debtDecimals: number;
  collateralDecimals: number;
}): { collateralToSeize: bigint; bonus: bigint } {
  const {
    debtToRepayNative,
    debtPriceWad,
    collateralPriceWad,
    liquidationBonusBps,
    debtDecimals,
    collateralDecimals,
  } = params;

  // USD value of debt to repay
  const debtUsd = assetUsdValue(debtToRepayNative, debtPriceWad, debtDecimals);

  // Price per native unit of collateral
  const colPricePerNative = collateralPriceWad / POW10[collateralDecimals];
  if (colPricePerNative === 0n) return { collateralToSeize: 0n, bonus: 0n };

  // Base collateral (no bonus)
  const baseCollateral = debtUsd / colPricePerNative;

  // Bonus collateral
  const bonus = (baseCollateral * BigInt(liquidationBonusBps)) / BPS;
  const collateralToSeize = baseCollateral + bonus;

  return { collateralToSeize, bonus };
}

/**
 * Total debt value in USD across all markets (WAD-scaled).
 * Used to determine the 50% liquidation cap.
 */
export function totalDebtUsd(
  positions: UserPositionForAsset[],
  prices: bigint[],
): bigint {
  let total = 0n;
  for (let i = 0; i < NUM_MARKETS; i++) {
    if (positions[i].debt > 0n) {
      total += assetUsdValue(positions[i].debt, prices[i], ASSET_DECIMALS[i]);
    }
  }
  return total;
}
