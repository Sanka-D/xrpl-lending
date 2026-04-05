/**
 * Aggregate user position view: collateral, debt (with interest), supply shares, HF.
 */

import { AssetIndex, WAD } from "./types";
import type { UserPositionForAsset, InterestState, UserHealthView } from "./types";
import type { LendingClient } from "./client";
import {
  decodeBigintLE,
  marketInterestKey,
  userPositionKey,
} from "./client";
import { LendingClient as LC } from "./client";
import { getActualDebt, calculateHealthFactor, calculateBorrowCapacity, ASSET_DECIMALS, assetUsdValue, HF_MAX } from "./health";
import { getAllPrices } from "./oracle";
import { V1_MARKETS } from "./types";

const ASSETS = [AssetIndex.XRP, AssetIndex.RLUSD, AssetIndex.WBTC] as const;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the full position for a user across all V1 markets.
 *
 * Issues all state reads concurrently (12 position keys + 21 interest keys + oracle).
 *
 * Returns a UserHealthView with:
 *   - Per-market collateral, actual debt (with accrued interest), supply shares
 *   - Aggregate health factor, total collateral/debt USD, borrow capacity
 */
export async function getUserPosition(
  client: LendingClient,
  account: string,
): Promise<UserHealthView> {
  const accountId = LC.addressToAccountId(account);

  // Fetch all state concurrently
  const [positionRaws, interestStates, oraclePrices] = await Promise.all([
    fetchPositionRaws(client, accountId),
    getAllInterestStates(client),
    getAllPrices(client),
  ]);

  // Build positions with actual (interest-adjusted) debt
  const positions: UserPositionForAsset[] = ASSETS.map((asset, i) => {
    const { collateral, principal, userBorrowIndex } = positionRaws[i];
    const currentBorrowIndex = interestStates[i].borrowIndex;

    const actualDebt =
      principal > 0n
        ? getActualDebt(principal, userBorrowIndex, currentBorrowIndex)
        : 0n;

    return {
      assetIndex: asset,
      collateral,
      debt: actualDebt,
      userBorrowIndex,
    };
  });

  const prices = oraclePrices.map(p => p.priceWad);

  // Compute aggregate metrics
  const healthFactor = calculateHealthFactor(positions, prices, getV1Configs());
  const borrowCapacityUsd = calculateBorrowCapacity(positions, prices, getV1Configs());

  let totalCollateralUsd = 0n;
  let totalDebtUsd = 0n;
  for (let i = 0; i < 3; i++) {
    if (positions[i].collateral > 0n) {
      totalCollateralUsd += assetUsdValue(positions[i].collateral, prices[i], ASSET_DECIMALS[i]);
    }
    if (positions[i].debt > 0n) {
      totalDebtUsd += assetUsdValue(positions[i].debt, prices[i], ASSET_DECIMALS[i]);
    }
  }

  return {
    account,
    healthFactor: healthFactor === HF_MAX ? WAD * 1000n : healthFactor,
    totalCollateralUsd,
    totalDebtUsd,
    borrowCapacityUsd,
    positions,
  };
}

/**
 * Read interest states for all 3 markets concurrently.
 */
export async function getAllInterestStates(client: LendingClient): Promise<InterestState[]> {
  return Promise.all(ASSETS.map(async (asset) => {
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
    } as InterestState;
  }));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface PositionRaw {
  collateral: bigint;
  principal: bigint;
  userBorrowIndex: bigint;
  supplyShares: bigint;
}

async function fetchPositionRaws(
  client: LendingClient,
  accountId: Uint8Array,
): Promise<PositionRaw[]> {
  const allKeys = ASSETS.flatMap((_, i) => [
    userPositionKey(accountId, i, "co"),
    userPositionKey(accountId, i, "de"),
    userPositionKey(accountId, i, "bi"),
    userPositionKey(accountId, i, "sh"),
  ]);

  const allValues = await Promise.all(allKeys.map(k => client.readContractState(k)));

  return ASSETS.map((_, i) => {
    const base = i * 4;
    const decode = (raw: Uint8Array | null) =>
      raw && raw.length >= 16 ? decodeBigintLE(raw.slice(0, 16)) : 0n;

    return {
      collateral: decode(allValues[base]),
      principal: decode(allValues[base + 1]),
      userBorrowIndex: allValues[base + 2] && allValues[base + 2]!.length >= 16
        ? decodeBigintLE(allValues[base + 2]!.slice(0, 16))
        : 10n ** 18n,
      supplyShares: decode(allValues[base + 3]),
    };
  });
}

function getV1Configs() {
  return [V1_MARKETS[AssetIndex.XRP], V1_MARKETS[AssetIndex.RLUSD], V1_MARKETS[AssetIndex.WBTC]];
}
