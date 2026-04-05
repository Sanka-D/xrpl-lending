/**
 * Lending Protocol — Supply / Borrow / Repay / Collateral Tests
 *
 * Covers:
 *  - Supply share minting (1:1 at fresh index, proportional afterwards)
 *  - Withdraw: redeem shares for underlying, InsufficientLiquidity rejection
 *  - Borrow capacity: exact boundary accept, 1-unit-over rejection
 *  - Borrow amount bounded by vault liquidity
 *  - Repay: capped at actual debt (no overpayment stored), full repayment zeroes debt
 *  - WithdrawCollateral: HF enforcement, multi-asset collateral
 *  - Multi-market: supply + borrow across 3 assets
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  WAD, AssetIndex,
  getUserPosition, getDebtBalance, getCollateralBalance, getSupplyShares,
  getAllInterestStates,
} from "xrpl-lending-sdk";
import { SimulatedLedger } from "../helpers/simulated-ledger.js";

// ── Test wallets (standard XRPL test addresses) ───────────────────────────────
const ALICE   = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BOB     = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const CHARLIE = "rGjF46jKSsSmVXxXhNYHLUxm58WaA9cEfq";

// ── Standard amounts ──────────────────────────────────────────────────────────
const XRP_UNIT   = 1_000_000n;           // 1 XRP = 1_000_000 drops
const RLUSD_UNIT = 1_000_000n;           // 1 RLUSD = 1_000_000 native units
const WBTC_UNIT  = 100_000_000n;         // 1 wBTC = 100_000_000 satoshis

// Default prices
const XRP_PRICE   = 2n * WAD;           // $2.00
const RLUSD_PRICE = WAD;                // $1.00 (pegged)
const WBTC_PRICE  = 60_000n * WAD;      // $60,000

// ── Helper ─────────────────────────────────────────────────────────────────────
function freshLedger(): SimulatedLedger {
  const l = new SimulatedLedger(1_700_000_000n);
  l.setOraclePrice(AssetIndex.XRP,   XRP_PRICE);
  l.setOraclePrice(AssetIndex.RLUSD, RLUSD_PRICE);
  l.setOraclePrice(AssetIndex.WBTC,  WBTC_PRICE);
  return l;
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPPLY
// ══════════════════════════════════════════════════════════════════════════════

describe("supply", () => {
  it("mints shares 1:1 at fresh index (supplyIndex = WAD)", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 50_000n * RLUSD_UNIT);

    const client = ledger.createClient(ALICE);
    const shares = await getSupplyShares(client, ALICE, AssetIndex.RLUSD);
    // shares = wadDiv(amount, WAD) = amount
    expect(shares).toBe(50_000n * RLUSD_UNIT);
  });

  it("two suppliers share proportionally — second at same index", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 60_000n * RLUSD_UNIT);
    ledger.supply(BOB,   AssetIndex.RLUSD, 40_000n * RLUSD_UNIT);

    const clientA = ledger.createClient(ALICE);
    const clientB = ledger.createClient(BOB);
    const sharesA = await getSupplyShares(clientA, ALICE, AssetIndex.RLUSD);
    const sharesB = await getSupplyShares(clientB, BOB,   AssetIndex.RLUSD);

    // Both at index=WAD → shares = amount
    expect(sharesA).toBe(60_000n * RLUSD_UNIT);
    expect(sharesB).toBe(40_000n * RLUSD_UNIT);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    expect(state.totalSupply).toBe(100_000n * RLUSD_UNIT);
  });

  it("supply XRP into XRP market increases totalSupply correctly", async () => {
    const ledger = freshLedger();
    const amount = 5_000n * XRP_UNIT;
    ledger.supply(ALICE, AssetIndex.XRP, amount);

    const state = ledger.getInterestState(AssetIndex.XRP);
    expect(state.totalSupply).toBe(amount);
    expect(state.totalBorrows).toBe(0n);
    expect(state.borrowIndex).toBe(WAD);
  });

  it("throws InvalidAmount when supplying zero", () => {
    const ledger = freshLedger();
    expect(() => ledger.supply(ALICE, AssetIndex.RLUSD, 0n)).toThrow("InvalidAmount");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// WITHDRAW
// ══════════════════════════════════════════════════════════════════════════════

describe("withdraw", () => {
  it("burns exact shares and returns underlying at 1:1 (fresh index)", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);

    const returned = ledger.withdraw(ALICE, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);
    expect(returned).toBe(10_000n * RLUSD_UNIT);

    const client = ledger.createClient(ALICE);
    const sharesAfter = await getSupplyShares(client, ALICE, AssetIndex.RLUSD);
    expect(sharesAfter).toBe(0n);
  });

  it("partial withdraw leaves correct shares remaining", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);
    ledger.withdraw(ALICE, AssetIndex.RLUSD, 3_000n * RLUSD_UNIT);

    const client = ledger.createClient(ALICE);
    const shares = await getSupplyShares(client, ALICE, AssetIndex.RLUSD);
    expect(shares).toBe(7_000n * RLUSD_UNIT);
  });

  it("throws WithdrawExceedsBalance when shares > owned", () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 1_000n * RLUSD_UNIT);

    expect(() =>
      ledger.withdraw(ALICE, AssetIndex.RLUSD, 1_001n * RLUSD_UNIT)
    ).toThrow("WithdrawExceedsBalance");
  });

  it("throws InsufficientLiquidity when vault is drained by borrowers", () => {
    const ledger = freshLedger();
    // Alice supplies 10K RLUSD
    ledger.supply(ALICE, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);
    // Bob borrows 9_000 RLUSD (vault has only 1,000 remaining)
    ledger.depositCollateral(BOB, AssetIndex.XRP, 20_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 9_000n * RLUSD_UNIT);

    // Alice tries to withdraw 5_000 RLUSD — only 1_000 in vault
    expect(() =>
      ledger.withdraw(ALICE, AssetIndex.RLUSD, 5_000n * RLUSD_UNIT)
    ).toThrow("InsufficientLiquidity");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// COLLATERAL
// ══════════════════════════════════════════════════════════════════════════════

describe("depositCollateral / withdrawCollateral", () => {
  it("deposits increase collateral balance", async () => {
    const ledger = freshLedger();
    ledger.depositCollateral(ALICE, AssetIndex.XRP, 5_000n * XRP_UNIT);

    const client = ledger.createClient(ALICE);
    const col = await getCollateralBalance(client, ALICE, AssetIndex.XRP);
    expect(col).toBe(5_000n * XRP_UNIT);
  });

  it("multiple deposits accumulate correctly", async () => {
    const ledger = freshLedger();
    ledger.depositCollateral(ALICE, AssetIndex.XRP, 3_000n * XRP_UNIT);
    ledger.depositCollateral(ALICE, AssetIndex.XRP, 2_000n * XRP_UNIT);

    const client = ledger.createClient(ALICE);
    const col = await getCollateralBalance(client, ALICE, AssetIndex.XRP);
    expect(col).toBe(5_000n * XRP_UNIT);
  });

  it("withdrawCollateral succeeds when HF remains ≥ 1.0 after withdrawal", async () => {
    const ledger = freshLedger();
    // 10,000 XRP @ $2 = $20K collateral, borrow $5K RLUSD, LTV 80% allows $16K
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    ledger.supply(ALICE, AssetIndex.RLUSD, 20_000n * RLUSD_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 5_000n * RLUSD_UNIT);

    // Remove 2,000 XRP: remaining = 8,000 XRP × $2 × 80% liq_thresh = $12,800 > $5,000 debt ✓
    expect(() =>
      ledger.withdrawCollateral(BOB, AssetIndex.XRP, 2_000n * XRP_UNIT)
    ).not.toThrow();

    const client = ledger.createClient(BOB);
    const col = await getCollateralBalance(client, BOB, AssetIndex.XRP);
    expect(col).toBe(8_000n * XRP_UNIT);
  });

  it("withdrawCollateral throws WithdrawWouldLiquidate when HF would drop below 1.0", async () => {
    const ledger = freshLedger();
    // 10,000 XRP @ $2, borrow 15,000 RLUSD
    // HF = 10K × $2 × 80% / 15K = 1.0667 (just above 1)
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    ledger.supply(ALICE, AssetIndex.RLUSD, 20_000n * RLUSD_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 15_000n * RLUSD_UNIT);

    // Removing 1,000 XRP: remaining = 9K × $2 × 80% = $14,400 < $15,000 → HF < 1
    expect(() =>
      ledger.withdrawCollateral(BOB, AssetIndex.XRP, 1_000n * XRP_UNIT)
    ).toThrow("WithdrawWouldLiquidate");
  });

  it("throws InsufficientCollateral when withdrawing more than deposited", () => {
    const ledger = freshLedger();
    ledger.depositCollateral(ALICE, AssetIndex.XRP, 1_000n * XRP_UNIT);

    expect(() =>
      ledger.withdrawCollateral(ALICE, AssetIndex.XRP, 1_001n * XRP_UNIT)
    ).toThrow("InsufficientCollateral");
  });

  it("multi-asset collateral: XRP + wBTC both count towards borrow capacity", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 200_000n * RLUSD_UNIT);
    // Bob deposits 5,000 XRP ($10K) and 0.1 wBTC ($6,000)
    ledger.depositCollateral(BOB, AssetIndex.XRP,  5_000n * XRP_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.WBTC, WBTC_UNIT / 10n);

    // Capacity = 5K × $2 × 75% + 0.1 × $60K × 73% = $7,500 + $4,380 = $11,880
    // Borrow 10,000 RLUSD < $11,880 → should succeed
    expect(() =>
      ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT)
    ).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BORROW
// ══════════════════════════════════════════════════════════════════════════════

describe("borrow", () => {
  let ledger: SimulatedLedger;

  beforeEach(() => {
    ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    // Capacity = 10,000 XRP × $2 × 75% LTV = $15,000
  });

  it("borrow within LTV capacity succeeds and records debt", async () => {
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);

    const client = ledger.createClient(BOB);
    const debt = await getDebtBalance(client, BOB, AssetIndex.RLUSD);
    expect(debt).toBeGreaterThanOrEqual(10_000n * RLUSD_UNIT - 1n);
    expect(debt).toBeLessThanOrEqual(10_000n * RLUSD_UNIT + 1n);
  });

  it("borrow at exact LTV boundary ($15,000) succeeds", () => {
    // Exactly 15,000 RLUSD = exactly at LTV limit
    expect(() =>
      ledger.borrow(BOB, AssetIndex.RLUSD, 15_000n * RLUSD_UNIT)
    ).not.toThrow();
  });

  it("borrow 1 unit over capacity throws BorrowCapacityExceeded", () => {
    // 15,001 RLUSD > $15,000 capacity
    expect(() =>
      ledger.borrow(BOB, AssetIndex.RLUSD, 15_001n * RLUSD_UNIT)
    ).toThrow("BorrowCapacityExceeded");
  });

  it("borrow updates market totalBorrows and totalSupply", () => {
    const amount = 8_000n * RLUSD_UNIT;
    ledger.borrow(BOB, AssetIndex.RLUSD, amount);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    expect(state.totalBorrows).toBe(amount);
    expect(state.totalSupply).toBe(100_000n * RLUSD_UNIT - amount);
  });

  it("borrow activates non-zero interest rate", () => {
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);
    const state = ledger.getInterestState(AssetIndex.RLUSD);
    // util = 10K / 100K = 10% < 90% optimal → slope1 rate
    expect(state.borrowRateBps).toBeGreaterThan(0n);
  });

  it("borrow limited by vault liquidity throws InsufficientBorrowLiquidity", () => {
    // Only 100K RLUSD in vault, try to borrow more than that
    // Need enough collateral first: 200K × $2 × 75% = $300K
    ledger.depositCollateral(BOB, AssetIndex.XRP, 200_000n * XRP_UNIT);

    expect(() =>
      ledger.borrow(BOB, AssetIndex.RLUSD, 100_001n * RLUSD_UNIT)
    ).toThrow("InsufficientBorrowLiquidity");
  });

  it("borrower can borrow from two different markets simultaneously", async () => {
    // Bob also needs RLUSD supply for XRP borrowing
    ledger.supply(CHARLIE, AssetIndex.XRP, 50_000n * XRP_UNIT);

    // Borrow 5,000 RLUSD + 1,000 XRP drops (within capacity)
    ledger.borrow(BOB, AssetIndex.RLUSD, 5_000n * RLUSD_UNIT);
    ledger.borrow(BOB, AssetIndex.XRP, 1_000n * XRP_UNIT);

    const client = ledger.createClient(BOB);
    const debtRlusd = await getDebtBalance(client, BOB, AssetIndex.RLUSD);
    const debtXrp   = await getDebtBalance(client, BOB, AssetIndex.XRP);

    expect(debtRlusd).toBeGreaterThan(0n);
    expect(debtXrp).toBeGreaterThan(0n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// REPAY
// ══════════════════════════════════════════════════════════════════════════════

describe("repay", () => {
  let ledger: SimulatedLedger;

  beforeEach(() => {
    ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 20_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);
  });

  it("partial repay reduces debt correctly", async () => {
    const repaid = ledger.repay(BOB, AssetIndex.RLUSD, 3_000n * RLUSD_UNIT);
    expect(repaid).toBe(3_000n * RLUSD_UNIT);

    const client = ledger.createClient(BOB);
    const debt = await getDebtBalance(client, BOB, AssetIndex.RLUSD);
    // Remaining debt ≈ 7,000 RLUSD (small interest accrued since no time passed)
    expect(debt).toBeGreaterThanOrEqual(7_000n * RLUSD_UNIT - 5n);
    expect(debt).toBeLessThanOrEqual(7_000n * RLUSD_UNIT + 5n);
  });

  it("repay caps at actual debt (overpayment not stored)", async () => {
    // Actual debt ≈ 10,000 RLUSD, attempt to repay 20,000
    const repaid = ledger.repay(BOB, AssetIndex.RLUSD, 20_000n * RLUSD_UNIT);

    // Should have repaid exactly the actual debt
    expect(repaid).toBeLessThanOrEqual(10_001n * RLUSD_UNIT); // ≤ 10K + 1 unit
    expect(repaid).toBeGreaterThan(0n);

    // Debt should now be zero
    const client = ledger.createClient(BOB);
    const debt = await getDebtBalance(client, BOB, AssetIndex.RLUSD);
    expect(debt).toBe(0n);
  });

  it("full repayment zeroes debt exactly", async () => {
    // Get exact current debt
    const client = ledger.createClient(BOB);
    const exactDebt = await getDebtBalance(client, BOB, AssetIndex.RLUSD);

    ledger.repay(BOB, AssetIndex.RLUSD, exactDebt);

    const debtAfter = await getDebtBalance(client, BOB, AssetIndex.RLUSD);
    expect(debtAfter).toBe(0n);
  });

  it("repay restores vault liquidity (totalSupply increases)", () => {
    const stateBefore = ledger.getInterestState(AssetIndex.RLUSD);
    const beforeSupply = stateBefore.totalSupply;

    ledger.repay(BOB, AssetIndex.RLUSD, 5_000n * RLUSD_UNIT);

    const stateAfter = ledger.getInterestState(AssetIndex.RLUSD);
    expect(stateAfter.totalSupply).toBeGreaterThan(beforeSupply);
    expect(stateAfter.totalBorrows).toBeLessThan(stateBefore.totalBorrows);
  });

  it("repay after 30 days includes accrued interest in actual debt", async () => {
    ledger.advanceTime(30n * 24n * 3600n);

    // Trigger interest accrual via a third-party supply (updates stored borrow index)
    // so that getDebtBalance reads the new index and computes actual debt correctly.
    ledger.supply(CHARLIE, AssetIndex.RLUSD, 1n * RLUSD_UNIT);

    const client = ledger.createClient(BOB);
    const debtWithInterest = await getDebtBalance(client, BOB, AssetIndex.RLUSD);

    // Interest > 0, so actual debt (principal × newIndex / userIndex) must exceed original
    expect(debtWithInterest).toBeGreaterThan(10_000n * RLUSD_UNIT);
  });

  it("throws NoBorrowBalance when account has no debt", () => {
    // Alice never borrowed anything
    expect(() =>
      ledger.repay(ALICE, AssetIndex.RLUSD, 1_000n * RLUSD_UNIT)
    ).toThrow("NoBorrowBalance");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH FACTOR
// ══════════════════════════════════════════════════════════════════════════════

describe("getUserPosition / health factor", () => {
  it("returns max HF (WAD * 1000) when no debt", async () => {
    const ledger = freshLedger();
    ledger.depositCollateral(ALICE, AssetIndex.XRP, 1_000n * XRP_UNIT);

    const client = ledger.createClient(ALICE);
    const view = await getUserPosition(client, ALICE);
    // positions.ts:81 caps the no-debt HF sentinel at WAD * 1000 for safe bigint handling
    expect(view.healthFactor).toBeGreaterThan(WAD);
    expect(view.healthFactor).toBeGreaterThanOrEqual(WAD * 1000n);
  });

  it("HF is exactly calculated for known values", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    // 10,000 XRP @ $2 = $20K; borrow 10,000 RLUSD @ $1 = $10K
    // HF = $20K × 80% (liq threshold) / $10K = 1.6
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);

    const client = ledger.createClient(BOB);
    const view = await getUserPosition(client, BOB);

    // Expected HF = (10K × 2 × 80%) / 10K = 1.6 WAD
    expect(view.healthFactor).toBeGreaterThan(WAD * 159n / 100n); // > 1.59
    expect(view.healthFactor).toBeLessThan(WAD * 161n / 100n);    // < 1.61

    expect(view.healthFactor).toBeGreaterThan(WAD); // healthy
  });

  it("HF drops below 1.0 when XRP price falls", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 10_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 15_000n * RLUSD_UNIT);
    // HF = 10K × $2 × 80% / 15K = 1.067

    // Drop price: 10K × $1.00 × 80% / 15K = 0.533 → liquidatable
    ledger.setOraclePrice(AssetIndex.XRP, WAD); // $1.00

    const client = ledger.createClient(BOB);
    const view = await getUserPosition(client, BOB);
    expect(view.healthFactor).toBeLessThan(WAD);
  });

  it("getAllInterestStates returns data for all 3 markets", async () => {
    const ledger = freshLedger();
    ledger.supply(ALICE, AssetIndex.RLUSD, 1_000n * RLUSD_UNIT);

    const client = ledger.createClient(ALICE);
    const states = await getAllInterestStates(client);

    expect(states).toHaveLength(3);
    const rlusdState = states.find(s => s.assetIndex === AssetIndex.RLUSD);
    expect(rlusdState).toBeDefined();
    expect(rlusdState!.totalSupply).toBe(1_000n * RLUSD_UNIT);
    expect(rlusdState!.borrowIndex).toBe(WAD);
    expect(rlusdState!.supplyIndex).toBe(WAD);
  });
});
