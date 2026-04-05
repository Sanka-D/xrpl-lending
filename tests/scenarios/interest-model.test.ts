/**
 * Interest Rate Model Tests
 *
 * Verifies the two-slope kinked interest rate model for all 3 markets:
 *   - At 0% utilization → base rate
 *   - Below kink → rate increases linearly with slope1
 *   - At kink exactly → rate = base + slope1
 *   - Above kink → rate jumps steeply with slope2
 *   - Borrow and supply indexes grow over time
 *   - Supply rate = borrow_rate × utilization × (1 - reserve_factor)
 *   - Interest accrual is multiplicative (compound), not additive
 */

import { describe, it, expect } from "vitest";
import { WAD, AssetIndex, V1_MARKETS } from "xrpl-lending-sdk";
import { SimulatedLedger } from "../helpers/simulated-ledger.js";

const XRP_UNIT   = 1_000_000n;
const RLUSD_UNIT = 1_000_000n;
const WBTC_UNIT  = 100_000_000n;

const ALICE   = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BOB     = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

// ══════════════════════════════════════════════════════════════════════════════
// INTEREST RATE MODEL
// ══════════════════════════════════════════════════════════════════════════════

describe("interest rate model — RLUSD market", () => {
  // RLUSD: optimal=90%, slope1=400bps, slope2=6000bps, base=0, reserve=10%

  it("rate is 0 bps at 0% utilization (no borrows)", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    // No borrows → util=0 → rate=0
    const state = ledger.getInterestState(AssetIndex.RLUSD);
    expect(state.borrowRateBps).toBe(0n);
    expect(state.supplyRateBps).toBe(0n);
  });

  it("rate ≈ slope1 × (U / U_opt) when U < U_opt", () => {
    // At 45% utilization (< 90% optimal for RLUSD):
    //   rate = 0 + (0.45 / 0.90) × 400 = 0.5 × 400 = 200 bps
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 200_000n * XRP_UNIT);
    // Borrow 45K out of 100K → util = 45% of (45K + 55K) = 45%
    ledger.borrow(BOB, AssetIndex.RLUSD, 45_000n * RLUSD_UNIT);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    // Expected: rate = (45/90) × 400 = 200 bps ±5
    expect(state.borrowRateBps).toBeGreaterThan(190n);
    expect(state.borrowRateBps).toBeLessThan(210n);
  });

  it("rate ≈ slope1 (400 bps) when utilization = 90% optimal", () => {
    // At exactly 90% utilization:
    //   rate = 0 + (0.90 / 0.90) × 400 = 400 bps
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 500_000n * XRP_UNIT);
    // Borrow 90K: util = 90K / 100K = 90%
    ledger.borrow(BOB, AssetIndex.RLUSD, 90_000n * RLUSD_UNIT);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    expect(state.borrowRateBps).toBeGreaterThan(395n);
    expect(state.borrowRateBps).toBeLessThan(405n);
  });

  it("rate jumps above slope1 when utilization exceeds optimal (slope2 kicks in)", () => {
    // At 95% utilization (> 90% optimal):
    //   excess = (95-90)/(100-90) = 5/10 = 50%
    //   rate = 0 + 400 + 0.50 × 6000 = 3,400 bps
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 1_000_000n * XRP_UNIT);
    // Borrow 95K: util ≈ 95%
    ledger.borrow(BOB, AssetIndex.RLUSD, 95_000n * RLUSD_UNIT);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    // Expected ≈ 3,400 bps — much higher than slope1 (400 bps)
    expect(state.borrowRateBps).toBeGreaterThan(3_000n);
    expect(state.borrowRateBps).toBeLessThan(4_000n);
  });
});

describe("interest rate model — XRP market", () => {
  // XRP: optimal=80%, slope1=400bps, slope2=30000bps, base=0, reserve=20%

  it("rate below kink is proportional to utilization × slope1", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.XRP, 100_000n * XRP_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.RLUSD, 500_000n * RLUSD_UNIT);
    // Borrow 40K XRP: util = 40K / 100K = 40%
    ledger.borrow(BOB, AssetIndex.XRP, 40_000n * XRP_UNIT);

    const state = ledger.getInterestState(AssetIndex.XRP);
    // rate = (0.40/0.80) × 400 = 200 bps ±5
    expect(state.borrowRateBps).toBeGreaterThan(190n);
    expect(state.borrowRateBps).toBeLessThan(210n);
  });

  it("rate above XRP kink (80%) is very high due to 300% slope2", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.XRP, 100_000n * XRP_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.RLUSD, 1_000_000n * RLUSD_UNIT);
    // Borrow 90K: util = 90%
    ledger.borrow(BOB, AssetIndex.XRP, 90_000n * XRP_UNIT);

    const state = ledger.getInterestState(AssetIndex.XRP);
    // rate = 0 + 400 + (90-80)/(100-80) × 30000 = 400 + 0.5 × 30000 = 15,400 bps
    expect(state.borrowRateBps).toBeGreaterThan(14_000n);
    expect(state.borrowRateBps).toBeLessThan(17_000n);
  });
});

describe("interest rate model — wBTC market", () => {
  // wBTC: optimal=45%, slope1=700bps, slope2=30000bps, base=0, reserve=20%

  it("wBTC rate increases steeply above 45% optimal utilization", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.WBTC, 10n * WBTC_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.RLUSD, 1_000_000n * RLUSD_UNIT);
    // Borrow 7 wBTC out of 10: util = 70% > optimal 45%
    ledger.borrow(BOB, AssetIndex.WBTC, 7n * WBTC_UNIT);

    const state = ledger.getInterestState(AssetIndex.WBTC);
    // rate = 0 + 700 + (70-45)/(100-45) × 30000 ≈ 700 + 13,636 ≈ 14,336 bps
    expect(state.borrowRateBps).toBeGreaterThan(12_000n);
    expect(state.borrowRateBps).toBeLessThan(16_000n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// INDEX ACCRUAL
// ══════════════════════════════════════════════════════════════════════════════

describe("interest index accrual", () => {
  it("borrow index grows over time when utilization > 0", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 50_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 50_000n * RLUSD_UNIT);

    const before = ledger.getInterestState(AssetIndex.RLUSD);
    expect(before.borrowIndex).toBe(WAD); // just borrowed, no time elapsed

    // Advance 1 year
    ledger.advanceTime(365n * 24n * 3600n);

    // Trigger accrual via a repay
    ledger.repay(BOB, AssetIndex.RLUSD, 1n); // minimal amount to trigger accrual

    const after = ledger.getInterestState(AssetIndex.RLUSD);
    expect(after.borrowIndex).toBeGreaterThan(WAD);
  });

  it("supply index grows less than borrow index (reserve factor)", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 50_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 50_000n * RLUSD_UNIT); // 50% utilization

    ledger.advanceTime(365n * 24n * 3600n);
    ledger.repay(BOB, AssetIndex.RLUSD, 1n);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    // Supply index growth < borrow index growth (reserve factor withholds some)
    const borrowGrowth = state.borrowIndex - WAD;
    const supplyGrowth = state.supplyIndex - WAD;
    expect(supplyGrowth).toBeGreaterThan(0n);
    expect(borrowGrowth).toBeGreaterThan(supplyGrowth); // borrow > supply (protocol earns reserve)
  });

  it("indexes do not grow when utilization is 0 (no borrows)", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    // No borrows

    ledger.advanceTime(365n * 24n * 3600n);
    // Trigger accrual via another supply
    ledger.supply(ALICE, AssetIndex.RLUSD, 1n * RLUSD_UNIT);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    // No borrow → no interest accrued → indexes stay at WAD
    expect(state.borrowIndex).toBe(WAD);
    expect(state.supplyIndex).toBe(WAD);
  });

  it("interest is compound: index grows exponentially over multiple periods", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 100_000n * XRP_UNIT);
    // 90% utilization → rate ≈ 400 bps
    ledger.borrow(BOB, AssetIndex.RLUSD, 90_000n * RLUSD_UNIT);

    // Accrue in two 6-month periods
    ledger.advanceTime(183n * 24n * 3600n);
    ledger.repay(BOB, AssetIndex.RLUSD, 1n);

    const midIndex = { ...ledger.getInterestState(AssetIndex.RLUSD) };

    ledger.advanceTime(183n * 24n * 3600n);
    ledger.repay(BOB, AssetIndex.RLUSD, 1n);

    const endState = ledger.getInterestState(AssetIndex.RLUSD);

    // Second period should show slightly more growth than first (compound effect)
    const firstPeriodGrowth  = midIndex.borrowIndex - WAD;
    const secondPeriodGrowth = endState.borrowIndex - midIndex.borrowIndex;

    // With compound interest, second period growth ≥ first period growth
    expect(secondPeriodGrowth).toBeGreaterThanOrEqual(firstPeriodGrowth);
  });

  it("borrower debt increases proportionally with borrow index", async () => {
    const { getDebtBalance } = await import("xrpl-lending-sdk");

    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 50_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 10_000n * RLUSD_UNIT);

    const clientBob = ledger.createClient(BOB);
    const debtAt0 = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);

    // Advance 90 days, trigger accrual via a THIRD-PARTY supply.
    // This updates the stored borrow index in state without touching Bob's debt position,
    // so getDebtBalance can read: principal × newIndex / userIndex > principal.
    ledger.advanceTime(90n * 24n * 3600n);
    ledger.supply(ALICE, AssetIndex.RLUSD, 1n); // triggers accrual, updates stored borrow index

    const debtAt90d = await getDebtBalance(clientBob, BOB, AssetIndex.RLUSD);
    // Debt should have grown: actual_debt = principal × newBorrowIndex / userBorrowIndex > principal
    expect(debtAt90d).toBeGreaterThan(debtAt0);
    // Growth should be plausible: < 5% for ~44 bps × 90/365 period
    expect(debtAt90d).toBeLessThan(debtAt0 + (debtAt0 * 5n) / 100n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPPLY RATE
// ══════════════════════════════════════════════════════════════════════════════

describe("supply rate", () => {
  it("supply rate is 0 when utilization is 0", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    const state = ledger.getInterestState(AssetIndex.RLUSD);
    expect(state.supplyRateBps).toBe(0n);
  });

  it("supply rate > 0 when there are borrows", () => {
    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    ledger.supply(ALICE, AssetIndex.RLUSD, 100_000n * RLUSD_UNIT);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 100_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 50_000n * RLUSD_UNIT);

    const state = ledger.getInterestState(AssetIndex.RLUSD);
    expect(state.supplyRateBps).toBeGreaterThan(0n);
    // Supply rate < borrow rate (reserve factor withholds some)
    expect(state.supplyRateBps).toBeLessThan(state.borrowRateBps);
  });

  it("supplier earns more RLUSD than deposited after 1 year at 50% utilization", async () => {
    const { getSupplyShares } = await import("xrpl-lending-sdk");

    const ledger = new SimulatedLedger(1_700_000_000n);
    ledger.setOraclePrice(AssetIndex.XRP,   2n * WAD);
    ledger.setOraclePrice(AssetIndex.RLUSD, WAD);
    ledger.setOraclePrice(AssetIndex.WBTC,  60_000n * WAD);

    const supplied = 100_000n * RLUSD_UNIT;
    ledger.supply(ALICE, AssetIndex.RLUSD, supplied);
    ledger.depositCollateral(BOB, AssetIndex.XRP, 200_000n * XRP_UNIT);
    ledger.borrow(BOB, AssetIndex.RLUSD, 50_000n * RLUSD_UNIT); // 50% util

    // Advance 1 year and trigger accrual
    ledger.advanceTime(365n * 24n * 3600n);
    ledger.repay(BOB, AssetIndex.RLUSD, 1n);

    const clientAlice = ledger.createClient(ALICE);
    const aliceShares = await getSupplyShares(clientAlice, ALICE, AssetIndex.RLUSD);
    const state = ledger.getInterestState(AssetIndex.RLUSD);

    // Value of Alice's shares = shares × supplyIndex / WAD
    const aliceValue = aliceShares * state.supplyIndex / WAD;
    expect(aliceValue).toBeGreaterThan(supplied); // earned interest
  });
});
