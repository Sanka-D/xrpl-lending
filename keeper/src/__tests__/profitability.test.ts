import { describe, it, expect } from "vitest";
import { filterProfitable, gasCostInUsd } from "../profitability";
import { WAD, AssetIndex } from "xrpl-lending-sdk";
import type { LiquidationOpportunity } from "xrpl-lending-sdk";

// Prices: XRP=$2, RLUSD=$1, wBTC=$60k
const PRICES = [2n * WAD, WAD, 60_000n * WAD];

function makeOpportunity(overrides: Partial<LiquidationOpportunity> = {}): LiquidationOpportunity {
  return {
    borrower: "rBorrowerXXXXXXXXXXXXXXXXXXXXXXXXX",
    healthFactor: WAD / 2n,
    debtAsset: AssetIndex.RLUSD,
    collateralAsset: AssetIndex.WBTC,
    maxDebtToRepay: 1_000_000_000n,
    collateralToSeize: 100_000n,
    estimatedProfitUsd: 50n * WAD,
    ...overrides,
  };
}

// ── gasCostInUsd ──────────────────────────────────────────────────────────────

describe("gasCostInUsd", () => {
  it("12 drops at $2 XRP = ~$0.000024", () => {
    // 12 drops × $2 / 1e6 = $0.000024 = 24000000000000n WAD
    const cost = gasCostInUsd(12n, 2n * WAD);
    // price_per_native = 2*WAD / 1e6 = 2e12
    // cost = 12 * 2e12 = 24e12
    expect(cost).toBe(24_000_000_000_000n);
  });

  it("zero drops = zero cost", () => {
    expect(gasCostInUsd(0n, 2n * WAD)).toBe(0n);
  });

  it("zero XRP price = zero cost", () => {
    expect(gasCostInUsd(12n, 0n)).toBe(0n);
  });
});

// ── filterProfitable ──────────────────────────────────────────────────────────

describe("filterProfitable", () => {
  const config = {
    minProfitUsd: 10n * WAD,    // $10 minimum
    liquidationGasCostDrops: 12n,
  };

  it("returns empty array for empty input", () => {
    expect(filterProfitable([], PRICES, config)).toEqual([]);
  });

  it("includes profitable opportunities above threshold", () => {
    const opp = makeOpportunity({ estimatedProfitUsd: 50n * WAD });
    const results = filterProfitable([opp], PRICES, config);
    expect(results).toHaveLength(1);
    expect(results[0].netProfitUsd).toBeGreaterThan(0n);
    expect(results[0].gasCostUsd).toBeGreaterThan(0n);
  });

  it("excludes opportunities below threshold", () => {
    // Profit = $5 < $10 minimum
    const opp = makeOpportunity({ estimatedProfitUsd: 5n * WAD });
    const results = filterProfitable([opp], PRICES, config);
    expect(results).toHaveLength(0);
  });

  it("gas cost is subtracted from profit", () => {
    const estimatedProfit = 50n * WAD;
    const opp = makeOpportunity({ estimatedProfitUsd: estimatedProfit });
    const results = filterProfitable([opp], PRICES, config);
    expect(results[0].netProfitUsd).toBe(estimatedProfit - results[0].gasCostUsd);
  });

  it("sorts by net profit descending", () => {
    const opps = [
      makeOpportunity({ estimatedProfitUsd: 20n * WAD, borrower: "rA" }),
      makeOpportunity({ estimatedProfitUsd: 50n * WAD, borrower: "rB" }),
      makeOpportunity({ estimatedProfitUsd: 30n * WAD, borrower: "rC" }),
    ];
    const results = filterProfitable(opps, PRICES, config);
    expect(results[0].borrower).toBe("rB");
    expect(results[1].borrower).toBe("rC");
    expect(results[2].borrower).toBe("rA");
  });

  it("excludes when gas cost exceeds gross profit", () => {
    // Profit = 0.000001 WAD (tiny), well below gas cost
    const opp = makeOpportunity({ estimatedProfitUsd: 1n });
    const results = filterProfitable([opp], PRICES, config);
    expect(results).toHaveLength(0);
  });

  it("attaches gasCostUsd to each result", () => {
    const opp = makeOpportunity({ estimatedProfitUsd: 100n * WAD });
    const results = filterProfitable([opp], PRICES, config);
    expect(results[0].gasCostUsd).toBe(gasCostInUsd(config.liquidationGasCostDrops, PRICES[AssetIndex.XRP]));
  });
});
