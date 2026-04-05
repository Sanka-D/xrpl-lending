/**
 * Profitability filter: subtract gas costs from liquidation profit estimates
 * and reject opportunities below the minimum profit threshold.
 */

import { AssetIndex, assetUsdValue, ASSET_DECIMALS } from "xrpl-lending-sdk";
import type { LiquidationOpportunity } from "xrpl-lending-sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfitableOpportunity extends LiquidationOpportunity {
  /** Net profit after deducting gas, WAD-scaled USD */
  netProfitUsd: bigint;
  /** Gas cost in WAD-scaled USD */
  gasCostUsd: bigint;
}

export interface ProfitabilityConfig {
  /** Minimum net profit required to execute, WAD-scaled USD */
  minProfitUsd: bigint;
  /** Estimated tx gas cost in XRP drops */
  liquidationGasCostDrops: bigint;
}

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Convert XRP drops to WAD-scaled USD value.
 *
 * Uses SDK's `assetUsdValue`:
 *   gasCostUsd = drops × xrpPriceWad / 10^6
 */
export function gasCostInUsd(drops: bigint, xrpPriceWad: bigint): bigint {
  return assetUsdValue(drops, xrpPriceWad, ASSET_DECIMALS[AssetIndex.XRP]);
}

/**
 * Filter and re-rank liquidation opportunities by net profit after gas.
 *
 * For each SDK-computed LiquidationOpportunity:
 *   netProfitUsd = estimatedProfitUsd - gasCostUsd
 *
 * Only opportunities with netProfitUsd >= config.minProfitUsd are returned,
 * sorted descending.
 */
export function filterProfitable(
  opportunities: LiquidationOpportunity[],
  prices: bigint[],
  config: ProfitabilityConfig,
): ProfitableOpportunity[] {
  const xrpPrice = prices[AssetIndex.XRP] ?? 0n;
  const gasCostUsd = gasCostInUsd(config.liquidationGasCostDrops, xrpPrice);

  const profitable: ProfitableOpportunity[] = [];

  for (const opp of opportunities) {
    const netProfitUsd = opp.estimatedProfitUsd - gasCostUsd;
    if (netProfitUsd >= config.minProfitUsd) {
      profitable.push({ ...opp, netProfitUsd, gasCostUsd });
    }
  }

  // Sort by net profit descending (best opportunity first)
  return profitable.sort((a, b) => (b.netProfitUsd > a.netProfitUsd ? 1 : -1));
}
