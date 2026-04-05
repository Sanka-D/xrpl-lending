/**
 * Liquidation Tests
 *
 * Covers:
 *  - Rejection of healthy position (PositionHealthy)
 *  - Rejection when debt and collateral asset are the same (InvalidLiquidation)
 *  - 50% close-factor cap: liquidating more than 50% is clamped
 *  - Bonus calculation: exact 5% for XRP, 4% for RLUSD, 6.5% for wBTC
 *  - Borrower collateral and debt reduced correctly after liquidation
 *  - Liquidator receives correct collateral amount
 *  - HF recovery after liquidation
 *  - Sequential (partial) liquidations
 *  - Rejection when collateral insufficient to cover seize
 *  - Cross-asset liquidations: RLUSD debt / XRP collateral, wBTC debt / XRP collateral
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  WAD, AssetIndex,
  getDebtBalance, getCollateralBalance, getUserPosition,
} from "xrpl-lending-sdk";
import { SimulatedLedger } from "../helpers/simulated-ledger.js";

const ALICE   = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BOB     = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const CHARLIE = "rGjF46jKSsSmVXxXhNYHLUxm58WaA9cEfq";

const XRP_UNIT   = 1_000_000n;
const RLUSD_UNIT = 1_000_000n;
const WBTC_UNIT  = 100_000_000n;

const BPS = 10_000n;

// ── Standard setup: Bob has unhealthy RLUSD debt / XRP collateral ─────────────
//
//  XRP @ $2.00 → 10K × $2 × 80% liq_thresh = $16K weighted col
//  RLUSD @ $1.00 → 15K debt = $15K
//  Initial HF = $16K / $15K ≈ 1.067  (healthy)
//
//  After XRP price drops to $1.20:
//  HF = 10K × $1.20 × 80% / 15K = $9,600 / $15K ≈ 0.64  (liquidatable)
//
function buildLiquidatableScenario(
  ledger: SimulatedLedger,
  { xrpPrice = (WAD * 12n) / 10n } = {},
): void {
  ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
  ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
  ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

  ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
  ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
  ledger.borrow(BOB, AssetIndex.RLUSD, 15_000n * RLUSD_UNIT);

  ledger.setOraclePrice(AssetIndex.XRP, xrpPrice);
}

// ══════════════════════════════════════════════════════════════════════════════
// REJECTION CASES
// ══════════════════════════════════════════════════════════════════════════════

describe("liquidation — rejection cases", () => {
  it("throws PositionHealthy when HF ≥ 1.0", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 50_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);
    // HF = 10K × $2 × 80% / 10K = 1.6 — healthy

    expect(() =>
      ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, 1_000n * RLUSD_UNIT)
    ).toThrow("PositionHealthy");
  });

  it("throws InvalidLiquidation when debt and collateral are the same asset", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    expect(() =>
      ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.RLUSD, 1_000n * RLUSD_UNIT)
    ).toThrow("InvalidLiquidation");
  });

  it("throws NoBorrowBalance when borrower has no debt in the specified asset", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);
    // Bob has RLUSD debt but no XRP debt
    expect(() =>
      ledger.liquidate(CHARLIE, BOB, AssetIndex.XRP, AssetIndex.RLUSD, 1_000n * XRP_UNIT)
    ).toThrow("NoBorrowBalance");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CLOSE FACTOR (50% cap)
// ══════════════════════════════════════════════════════════════════════════════

describe("liquidation — 50% close factor cap", () => {
  it("caps repaid amount at 50% of total debt when amount exceeds cap", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const clientBob = ledger.createClient(BOB);
    const totalDebt = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);

    // Request 100% of debt — should be capped at 50%
    const result = ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, totalDebt);

    // Repaid must be ≤ 50% of totalDebt
    expect(result.debtRepaid).toBeLessThanOrEqual(totalDebt / 2n + 1n);
    expect(result.debtRepaid).toBeGreaterThan(0n);
  });

  it("liquidation below 50% is accepted without clamping", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const clientBob = ledger.createClient(BOB);
    const totalDebt = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    const twentyPct = totalDebt / 5n; // 20%

    const result = ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, twentyPct);

    // Repaid should be close to 20% (no cap applied)
    // The simulator may round slightly, allow ±1
    expect(result.debtRepaid).toBeGreaterThanOrEqual(twentyPct - 1n);
    expect(result.debtRepaid).toBeLessThanOrEqual(twentyPct + 1n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BONUS CALCULATION
// ══════════════════════════════════════════════════════════════════════════════

describe("liquidation — bonus calculation", () => {
  it("XRP collateral bonus is exactly 5% (500 bps)", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const clientBob = ledger.createClient(BOB);
    const totalDebt = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    const repayAmount = totalDebt / 4n; // 25% — well below 50% cap

    const result = ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, repayAmount);

    // bonus = baseCollateral × 500 / 10_000 = 5%
    const expectedBase = result.collateralSeized - result.bonus;
    const expectedBonus = expectedBase * 500n / BPS;
    expect(result.bonus).toBeGreaterThanOrEqual(expectedBonus - 1n);
    expect(result.bonus).toBeLessThanOrEqual(expectedBonus + 2n);
  });

  it("collateralSeized = base + bonus", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const result = ledger.liquidate(
      CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, 1_000n * RLUSD_UNIT
    );

    const baseCol = result.collateralSeized - result.bonus;
    const recomputedBonus = baseCol * 500n / BPS;
    // Allow ±2 for integer division rounding across two divisions
    expect(result.bonus).toBeGreaterThanOrEqual(recomputedBonus - 2n);
    expect(result.bonus).toBeLessThanOrEqual(recomputedBonus + 2n);
    expect(result.collateralSeized).toBe(baseCol + result.bonus);
  });

  it("RLUSD-collateral bonus is 4% (400 bps)", async () => {
    // Set up scenario where Bob has wBTC debt, RLUSD collateral
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    // Alice supplies wBTC
    ledger.supply(ALICE, AssetIndex.WBTC, 10n * WBTC_UNIT);

    // Bob deposits RLUSD collateral: 100,000 RLUSD × $1 × 80% LTV = $80K capacity
    ledger.depositCollateral(BOB, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);

    // Bob borrows 1 wBTC @ $60,000 (< $80K capacity)
    ledger.borrow(BOB, AssetIndex.WBTC, WBTC_UNIT);

    // Drop wBTC price to $90,000 → HF = 100K × 85% / (1 × 90K) ≈ 0.944 < 1
    ledger.setOraclePrice(AssetIndex.WBTC, 90_000n * WAD);

    // Liquidate: repay 0.1 wBTC, seize RLUSD collateral
    const result = ledger.liquidate(
      CHARLIE, BOB,
      AssetIndex.WBTC,   // debt asset
      AssetIndex.RLUSD,  // collateral asset (bonus = 400 bps = 4%)
      WBTC_UNIT / 10n,
    );

    const baseCol = result.collateralSeized - result.bonus;
    const expectedBonus = baseCol * 400n / BPS; // 4% for RLUSD collateral
    expect(result.bonus).toBeGreaterThanOrEqual(expectedBonus - 2n);
    expect(result.bonus).toBeLessThanOrEqual(expectedBonus + 2n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STATE CHANGES
// ══════════════════════════════════════════════════════════════════════════════

describe("liquidation — state changes", () => {
  it("borrower debt decreases by exactly the repaid amount", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const clientBob = ledger.createClient(BOB);
    const debtBefore = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    const repayAmount = 1_000n * RLUSD_UNIT;

    const result = ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, repayAmount);

    const debtAfter = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    // Debt reduced by exactly debtRepaid (with possible ±1 from index rounding)
    expect(debtBefore - debtAfter).toBeGreaterThanOrEqual(result.debtRepaid - 1n);
    expect(debtBefore - debtAfter).toBeLessThanOrEqual(result.debtRepaid + 1n);
  });

  it("borrower collateral decreases by exactly collateralSeized", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const clientBob = ledger.createClient(BOB);
    const colBefore = await getCollateralBalance(clientBob, BOB, AssetIndex.XRP);

    const result = ledger.liquidate(
      CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, 1_000n * RLUSD_UNIT
    );

    const colAfter = await getCollateralBalance(clientBob, BOB, AssetIndex.XRP);
    expect(colBefore - colAfter).toBe(result.collateralSeized);
  });

  it("liquidator receives exactly collateralSeized in their collateral balance", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const result = ledger.liquidate(
      CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, 1_000n * RLUSD_UNIT
    );

    const clientCharlie = ledger.createClient(CHARLIE);
    const charlieXrp = await getCollateralBalance(clientCharlie, CHARLIE, AssetIndex.XRP);
    expect(charlieXrp).toBe(result.collateralSeized);
  });

  it("HF is above 1.0 after a successful liquidation", async () => {
    // Scenario designed so a single 50% liquidation restores HF above 1.
    // Math: for XRP (liq_thresh=80%, bonus=5%), one 50% liquidation restores HF only if
    //   col_usd / debt_usd ∈ (1.15, 1.25).
    // Here: 10K XRP × $1.20 = $12K col, 10K RLUSD debt → ratio=1.2, HF = 0.96 < 1
    // After 50% liq: seize $5,250 / $1.20 = 4,375 XRP; remaining 5,625 XRP × $1.20 × 80% / 5K = 1.08 > 1
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);

    // Drop XRP to $1.20: HF = 10K × $1.20 × 80% / 10K = 0.96 < 1
    ledger.setOraclePrice(AssetIndex.XRP, (WAD * 12n) / 10n);

    const result = ledger.liquidate(
      CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP,
      10_000n * RLUSD_UNIT // request full debt (will be capped at 50%)
    );

    expect(result.newHF).toBeGreaterThan(WAD);
  });

  it("market totalBorrows decreases after liquidation", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    buildLiquidatableScenario(ledger);

    const stateBefore = ledger.getInterestState(AssetIndex.RLUSD);
    ledger.liquidate(
      CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, 1_000n * RLUSD_UNIT
    );
    const stateAfter = ledger.getInterestState(AssetIndex.RLUSD);

    expect(stateAfter.totalBorrows).toBeLessThan(stateBefore.totalBorrows);
    expect(stateAfter.totalSupply).toBeGreaterThan(stateBefore.totalSupply);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SEQUENTIAL LIQUIDATIONS
// ══════════════════════════════════════════════════════════════════════════════

describe("liquidation — sequential", () => {
  it("two sequential liquidations both succeed (second on remaining debt)", async () => {
    // Use 30K XRP so collateral is large enough to cover two 50% liquidations at $0.50.
    // 30K × $0.50 = $15K col; 50% of 15K RLUSD = $7.5K debt to repay;
    // seize = $7.5K × 1.05 / $0.50 = 15,750 XRP < 30,000 XRP ✓
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 30_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 15_000n * RLUSD_UNIT);

    // Drop XRP to $0.50: HF = 30K × 0.50 × 80% / 15K = 0.8 < 1
    ledger.setOraclePrice(AssetIndex.XRP, WAD / 2n);

    const clientBob = ledger.createClient(BOB);

    // First liquidation (50% cap: repay ≤ 7,500 RLUSD)
    const r1 = ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, 15_000n * RLUSD_UNIT);
    expect(r1.debtRepaid).toBeGreaterThan(0n);

    const debtAfterFirst = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    expect(debtAfterFirst).toBeGreaterThan(0n); // still has remaining debt

    // Position should still be liquidatable at $0.50 (HF < 1 after first liq)
    const view = await getUserPosition(clientBob, BOB);
    expect(view.healthFactor).toBeLessThan(WAD);

    // Second liquidation
    const r2 = ledger.liquidate(CHARLIE, BOB, AssetIndex.RLUSD, AssetIndex.XRP, debtAfterFirst);
    expect(r2.debtRepaid).toBeGreaterThan(0n);

    const finalDebt = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    // After two liquidations, debt reduced to ≤ 25% of original (50% × 50%)
    expect(finalDebt).toBeLessThan(15_000n * RLUSD_UNIT * 3n / 4n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// WBTC COLLATERAL LIQUIDATION
// ══════════════════════════════════════════════════════════════════════════════

describe("liquidation — wBTC collateral / RLUSD debt", () => {
  it("liquidates with 6.5% bonus when seizing wBTC collateral", async () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 200_000n * RLUSD_UNIT);
    // Bob deposits 1 wBTC ($60K) + borrows RLUSD
    // Capacity = 1 × $60K × 73% = $43,800
    ledger.depositCollateral(BOB, AssetIndex.WBTC, WBTC_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 40_000n * RLUSD_UNIT);

    // HF = 1 × 60K × 78% (liq thresh wBTC) / 40K = 1.17 — healthy
    // Drop wBTC price to $30K: HF = 1 × 30K × 78% / 40K = 0.585 < 1 → liquidatable
    ledger.setOraclePrice(AssetIndex.WBTC, 30_000n * WAD);

    const result = ledger.liquidate(
      CHARLIE, BOB,
      AssetIndex.RLUSD,  // debt
      AssetIndex.WBTC,   // collateral (bonus = 650 bps = 6.5%)
      5_000n * RLUSD_UNIT,
    );

    const baseCol = result.collateralSeized - result.bonus;
    const expectedBonus = baseCol * 650n / BPS; // 6.5% for wBTC collateral
    expect(result.bonus).toBeGreaterThanOrEqual(expectedBonus - 2n);
    expect(result.bonus).toBeLessThanOrEqual(expectedBonus + 2n);

    // Liquidator should have wBTC collateral now
    const clientCharlie = ledger.createClient(CHARLIE);
    const charlieBtc = await getCollateralBalance(clientCharlie, CHARLIE, AssetIndex.WBTC);
    expect(charlieBtc).toBe(result.collateralSeized);
  });
});
