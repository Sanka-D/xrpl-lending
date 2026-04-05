/**
 * Liquidation: submit liquidate calls, scan for undercollateralized positions.
 */

import { AssetIndex, WAD, V1_MARKETS } from "./types";
import type { LiquidationOpportunity } from "./types";
import type { LendingClient, TxResult } from "./client";
import { encodeU32LE, encodeU64LE } from "./client";
import { LendingClient as LC } from "./client";
import {
  isLiquidatable,
  calculateMaxLiquidation,
  calculateLiquidationAmounts,
  assetUsdValue,
  ASSET_DECIMALS,
  totalDebtUsd,
} from "./health";
import { getUserPosition } from "./positions";
import { getAllPrices } from "./oracle";

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Liquidate an undercollateralized position.
 *
 * WASM: liquidate(borrower_ptr: u32, debt_id: u32, collat_id: u32, amount: u64)
 *
 * Encoding: 20-byte borrower AccountID (raw) + encodeU32LE(debtAsset)
 *           + encodeU32LE(collateralAsset) + encodeU64LE(debtAmount)   = 36 bytes total
 *
 * The XLS-101 runtime maps the InvokeArgs payload into WASM linear memory.
 * borrower_ptr will be the offset of the 20-byte AccountID within that buffer
 * (offset 0 in this encoding). This convention must be validated on AlphaNet.
 */
export async function liquidate(
  client: LendingClient,
  params: {
    borrower: string;
    debtAsset: AssetIndex;
    collateralAsset: AssetIndex;
    debtAmount: bigint;
  },
): Promise<TxResult> {
  const borrowerAccountId = LC.addressToAccountId(params.borrower);

  const args = new Uint8Array(36);
  args.set(borrowerAccountId, 0);                               // bytes 0–19
  args.set(encodeU32LE(params.debtAsset), 20);                  // bytes 20–23
  args.set(encodeU32LE(params.collateralAsset), 24);            // bytes 24–27
  args.set(encodeU64LE(params.debtAmount), 28);                 // bytes 28–35

  return client.submitInvoke("liquidate", args);
}

// ── Scanning ──────────────────────────────────────────────────────────────────

/**
 * Scan a list of accounts and return liquidation opportunities (HF < 1.0).
 *
 * For each undercollateralized borrower, selects the optimal (debtAsset, collateralAsset)
 * pair by largest debt and largest collateral, and computes:
 *   - maxDebtToRepay   (50% of total debt in native units)
 *   - collateralToSeize (with liquidation bonus)
 *   - estimatedProfitUsd (bonus value in USD)
 *
 * NOTE: XRPL has no on-chain account enumeration. Callers must supply the list
 * (e.g. from an off-chain indexer or event log).
 */
export async function findLiquidatablePositions(
  client: LendingClient,
  accounts: string[],
): Promise<LiquidationOpportunity[]> {
  // Fetch prices once for all accounts
  const oraclePrices = await getAllPrices(client);
  const prices = oraclePrices.map(p => p.priceWad);

  const opportunities: LiquidationOpportunity[] = [];

  await Promise.all(
    accounts.map(async (account) => {
      let view: Awaited<ReturnType<typeof getUserPosition>>;
      try {
        view = await getUserPosition(client, account);
      } catch {
        return; // skip if state unavailable
      }

      if (!isLiquidatable(view.healthFactor)) return;

      // Find asset with largest debt
      let debtAsset = AssetIndex.XRP;
      let maxDebtUsd = 0n;
      for (let i = 0; i < 3; i++) {
        const pos = view.positions[i];
        if (pos.debt > 0n) {
          const debtUsd = assetUsdValue(pos.debt, prices[i], ASSET_DECIMALS[i]);
          if (debtUsd > maxDebtUsd) {
            maxDebtUsd = debtUsd;
            debtAsset = pos.assetIndex;
          }
        }
      }

      // Find asset with largest collateral
      let collateralAsset = AssetIndex.XRP;
      let maxColUsd = 0n;
      for (let i = 0; i < 3; i++) {
        const pos = view.positions[i];
        if (pos.collateral > 0n) {
          const colUsd = assetUsdValue(pos.collateral, prices[i], ASSET_DECIMALS[i]);
          if (colUsd > maxColUsd) {
            maxColUsd = colUsd;
            collateralAsset = pos.assetIndex;
          }
        }
      }

      const totalDebt = totalDebtUsd(view.positions, prices);
      const maxRepayUsd = calculateMaxLiquidation(totalDebt);

      // Convert max repay USD → native units of debt asset
      const debtPriceWad = prices[debtAsset];
      const debtDecimals = ASSET_DECIMALS[debtAsset];
      const pricePerNative = debtPriceWad / 10n ** BigInt(debtDecimals);
      const maxDebtNative = pricePerNative > 0n ? maxRepayUsd / pricePerNative : 0n;

      // Cap to user's actual debt
      const userDebtNative = view.positions[debtAsset].debt;
      const debtToRepay = maxDebtNative < userDebtNative ? maxDebtNative : userDebtNative;

      const colConfig = [V1_MARKETS[AssetIndex.XRP], V1_MARKETS[AssetIndex.RLUSD], V1_MARKETS[AssetIndex.WBTC]][collateralAsset];

      const { collateralToSeize, bonus } = calculateLiquidationAmounts({
        debtToRepayNative: debtToRepay,
        debtPriceWad,
        collateralPriceWad: prices[collateralAsset],
        liquidationBonusBps: colConfig.liquidationBonus,
        debtDecimals,
        collateralDecimals: ASSET_DECIMALS[collateralAsset],
      });

      const colPricePerNative = prices[collateralAsset] / 10n ** BigInt(ASSET_DECIMALS[collateralAsset]);
      const estimatedProfitUsd = bonus * colPricePerNative;

      opportunities.push({
        borrower: account,
        healthFactor: view.healthFactor,
        debtAsset,
        collateralAsset,
        maxDebtToRepay: debtToRepay,
        collateralToSeize,
        estimatedProfitUsd,
      });
    }),
  );

  // Sort by estimated profit descending
  return opportunities.sort((a, b) =>
    b.estimatedProfitUsd > a.estimatedProfitUsd ? 1 : -1,
  );
}
