import { describe, it, expect } from "vitest";
import {
  assetUsdValue,
  calculateHealthFactor,
  calculateBorrowCapacity,
  getActualDebt,
  isLiquidatable,
  calculateMaxLiquidation,
  calculateLiquidationAmounts,
  HF_MAX,
  ASSET_DECIMALS,
} from "../health";
import { WAD, AssetIndex, V1_MARKETS } from "../types";
import type { UserPositionForAsset, MarketConfig } from "../types";

const XRP_MARKET = V1_MARKETS[AssetIndex.XRP];
const RLUSD_MARKET = V1_MARKETS[AssetIndex.RLUSD];
const WBTC_MARKET = V1_MARKETS[AssetIndex.WBTC];
const CONFIGS: MarketConfig[] = [XRP_MARKET, RLUSD_MARKET, WBTC_MARKET];

function emptyPositions(): UserPositionForAsset[] {
  return [
    { assetIndex: AssetIndex.XRP,   collateral: 0n, debt: 0n, userBorrowIndex: WAD },
    { assetIndex: AssetIndex.RLUSD, collateral: 0n, debt: 0n, userBorrowIndex: WAD },
    { assetIndex: AssetIndex.WBTC,  collateral: 0n, debt: 0n, userBorrowIndex: WAD },
  ];
}

// Prices: XRP=$2.00, RLUSD=$1.00, wBTC=$60,000
const PRICES = [2n * WAD, WAD, 60_000n * WAD];

// ── assetUsdValue ─────────────────────────────────────────────────────────────

describe("assetUsdValue", () => {
  it("zero amount returns 0", () => {
    expect(assetUsdValue(0n, 2n * WAD, 6)).toBe(0n);
  });

  it("zero price returns 0", () => {
    expect(assetUsdValue(1_000_000n, 0n, 6)).toBe(0n);
  });

  it("XRP: 1,000,000 drops @ $2.00 = $2.00 WAD", () => {
    // 1 XRP = 1,000,000 drops, decimals=6
    // price_per_native = 2*WAD / 1e6 = 2e12
    // value = 1e6 * 2e12 = 2e18 = 2 WAD
    expect(assetUsdValue(1_000_000n, 2n * WAD, 6)).toBe(2n * WAD);
  });

  it("RLUSD: 1,000,000 units @ $1.00 = $1.00 WAD", () => {
    expect(assetUsdValue(1_000_000n, WAD, 6)).toBe(WAD);
  });

  it("wBTC: 1 satoshi @ $60,000 = ~$0.0006", () => {
    // 1 satoshi, decimals=8, price=$60k WAD
    // price_per_native = 60000*WAD / 1e8 = 6e14
    // value = 1 * 6e14
    expect(assetUsdValue(1n, 60_000n * WAD, 8)).toBe(60_000n * WAD / 100_000_000n);
  });

  it("wBTC: 1 BTC (1e8 satoshis) @ $60,000 = $60,000 WAD", () => {
    expect(assetUsdValue(100_000_000n, 60_000n * WAD, 8)).toBe(60_000n * WAD);
  });
});

// ── calculateHealthFactor ─────────────────────────────────────────────────────

describe("calculateHealthFactor", () => {
  it("no debt returns HF_MAX", () => {
    const pos = emptyPositions();
    pos[0].collateral = 10_000_000n;
    expect(calculateHealthFactor(pos, PRICES, CONFIGS)).toBe(HF_MAX);
  });

  it("empty position returns HF_MAX", () => {
    expect(calculateHealthFactor(emptyPositions(), PRICES, CONFIGS)).toBe(HF_MAX);
  });

  it("healthy single-asset position", () => {
    // 10,000 RLUSD collateral, 5,000 RLUSD debt
    // HF = 10000 * 0.85 / 5000 = 1.7
    const pos = emptyPositions();
    pos[1].collateral = 10_000_000_000n; // 10,000 RLUSD (6 decimals)
    pos[1].debt = 5_000_000_000n;
    const hf = calculateHealthFactor(pos, PRICES, CONFIGS);
    expect(hf).toBe((17n * WAD) / 10n); // 1.7 WAD
  });

  it("liquidatable position (HF < 1.0)", () => {
    // 10,000 RLUSD collateral, 9,500 RLUSD debt
    // HF = 10000 * 0.85 / 9500 ≈ 0.894
    const pos = emptyPositions();
    pos[1].collateral = 10_000_000_000n;
    pos[1].debt = 9_500_000_000n;
    const hf = calculateHealthFactor(pos, PRICES, CONFIGS);
    expect(hf).toBeLessThan(WAD);
  });

  it("HF exactly 1.0", () => {
    // 10,000 RLUSD collateral, 8,500 RLUSD debt → HF = 10000*0.85/8500 = 1.0
    const pos = emptyPositions();
    pos[1].collateral = 10_000_000_000n;
    pos[1].debt = 8_500_000_000n;
    const hf = calculateHealthFactor(pos, PRICES, CONFIGS);
    expect(hf).toBe(WAD);
  });
});

// ── calculateBorrowCapacity ───────────────────────────────────────────────────

describe("calculateBorrowCapacity", () => {
  it("no position returns 0", () => {
    expect(calculateBorrowCapacity(emptyPositions(), PRICES, CONFIGS)).toBe(0n);
  });

  it("pure collateral, no debt", () => {
    // 1 XRP ($2.00), LTV=75%: capacity = $1.50
    const pos = emptyPositions();
    pos[0].collateral = 1_000_000n;
    const cap = calculateBorrowCapacity(pos, PRICES, CONFIGS);
    expect(cap).toBe(15n * WAD / 10n); // $1.50
  });

  it("saturates to 0 when over-borrowed", () => {
    // debt exceeds LTV capacity
    const pos = emptyPositions();
    pos[1].collateral = 10_000_000_000n;
    pos[1].debt = 9_000_000_000n; // exceeds LTV capacity
    expect(calculateBorrowCapacity(pos, PRICES, CONFIGS)).toBe(0n);
  });
});

// ── getActualDebt ─────────────────────────────────────────────────────────────

describe("getActualDebt", () => {
  it("no accrual (index unchanged)", () => {
    expect(getActualDebt(1_000n, WAD, WAD)).toBe(1_000n);
  });

  it("index doubled → debt doubled", () => {
    expect(getActualDebt(1_000n, WAD, 2n * WAD)).toBe(2_000n);
  });

  it("zero principal returns 0", () => {
    expect(getActualDebt(0n, WAD, 2n * WAD)).toBe(0n);
  });

  it("zero user index returns 0 (guard)", () => {
    expect(getActualDebt(1_000n, 0n, WAD)).toBe(0n);
  });
});

// ── isLiquidatable ────────────────────────────────────────────────────────────

describe("isLiquidatable", () => {
  it("HF = 1.0 is not liquidatable", () => {
    expect(isLiquidatable(WAD)).toBe(false);
  });

  it("HF > 1.0 is not liquidatable", () => {
    expect(isLiquidatable(15n * WAD / 10n)).toBe(false);
  });

  it("HF < 1.0 is liquidatable", () => {
    expect(isLiquidatable(WAD - 1n)).toBe(true);
  });

  it("HF = 0 is liquidatable", () => {
    expect(isLiquidatable(0n)).toBe(true);
  });
});

// ── calculateMaxLiquidation ───────────────────────────────────────────────────

describe("calculateMaxLiquidation", () => {
  it("50% of debt", () => {
    expect(calculateMaxLiquidation(10_000n * WAD)).toBe(5_000n * WAD);
  });

  it("zero debt", () => {
    expect(calculateMaxLiquidation(0n)).toBe(0n);
  });
});

// ── calculateLiquidationAmounts ───────────────────────────────────────────────

describe("calculateLiquidationAmounts", () => {
  it("RLUSD debt → RLUSD collateral (4% bonus)", () => {
    // Repay 1,000 RLUSD of debt. Seize RLUSD collateral with 4% bonus.
    // base = 1000 RLUSD, bonus = 40 RLUSD, total = 1040 RLUSD
    const result = calculateLiquidationAmounts({
      debtToRepayNative: 1_000_000_000n, // 1000 RLUSD (6 decimals)
      debtPriceWad: WAD,
      collateralPriceWad: WAD,
      liquidationBonusBps: 400, // 4%
      debtDecimals: 6,
      collateralDecimals: 6,
    });
    expect(result.collateralToSeize).toBe(1_040_000_000n);
    expect(result.bonus).toBe(40_000_000n);
  });

  it("RLUSD debt → XRP collateral (5% bonus, XRP @ $2)", () => {
    // Repay 1,000 RLUSD ($1000 USD). Seize XRP @ $2.00 with 5% bonus.
    // base = 500 XRP = 500,000,000 drops
    // bonus = 25 XRP = 25,000,000 drops
    // total = 525 XRP = 525,000,000 drops
    const result = calculateLiquidationAmounts({
      debtToRepayNative: 1_000_000_000n, // 1000 RLUSD
      debtPriceWad: WAD,
      collateralPriceWad: 2n * WAD,
      liquidationBonusBps: 500, // 5%
      debtDecimals: 6,
      collateralDecimals: 6,
    });
    expect(result.collateralToSeize).toBe(525_000_000n);
    expect(result.bonus).toBe(25_000_000n);
  });
});
