/**
 * SimulatedLedger — deterministic in-memory simulation of the lending controller.
 *
 * Mirrors the Rust contract logic exactly:
 *   - WAD math: wad_mul (rounded half-up), wad_div
 *   - Compound interest: 2-term Taylor series
 *   - Kinked two-slope interest rate model
 *   - Supply/withdraw, collateral, borrow/repay, liquidation
 *
 * State is stored in the same key format as the on-chain contract so that
 * the SDK's read functions (getUserPosition, getDebtBalance, etc.) work
 * transparently against the simulated state.
 */

import { encodeAccountID, decodeAccountID } from "xrpl";
import {
  LendingClient, AssetIndex, V1_MARKETS, WAD, ASSET_NAMES,
  marketInterestKey, userPositionKey,
} from "xrpl-lending-sdk";
import type { LendingClient as LendingClientType, TxResult } from "xrpl-lending-sdk";

// ── WAD Math (mirrors math.rs) ────────────────────────────────────────────────

const HALF_WAD = WAD / 2n;
const BPS = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;

/** (a × b + HALF_WAD) / WAD — rounded half-up */
function wadMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a * b + HALF_WAD) / WAD;
}

/** (a × WAD + b/2) / b — rounded half-up */
function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("wadDiv: division by zero");
  return (a * WAD + b / 2n) / b;
}

/** Convert annual BPS to per-second WAD rate */
function annualBpsToPerSecondWad(annualBps: bigint): bigint {
  return (annualBps * WAD) / (BPS * SECONDS_PER_YEAR);
}

/**
 * 2-term Taylor compound: 1 + rt + (rt)²/2
 * Mirrors calculate_compound_interest in math.rs
 */
function calculateCompoundInterest(ratePerSec: bigint, duration: bigint): bigint {
  if (duration === 0n) return WAD;
  const rt = ratePerSec * duration;
  if (duration === 1n) return WAD + rt;
  const rtSquared = wadMul(rt, rt);
  const secondTerm = rtSquared / 2n;
  return WAD + rt + secondTerm;
}

// ── Interest State (mirrors interest.rs) ─────────────────────────────────────

interface SimInterestState {
  borrowRateBps: bigint;
  supplyRateBps: bigint;
  borrowIndex: bigint;
  supplyIndex: bigint;
  lastUpdateTimestamp: bigint;
  totalBorrows: bigint;
  totalSupply: bigint;
}

function freshInterestState(): SimInterestState {
  return {
    borrowRateBps: 0n,
    supplyRateBps: 0n,
    borrowIndex: WAD,
    supplyIndex: WAD,
    lastUpdateTimestamp: 0n,
    totalBorrows: 0n,
    totalSupply: 0n,
  };
}

/** Utilization = totalBorrows × WAD / (totalBorrows + totalSupply) */
function calculateUtilization(totalBorrows: bigint, totalSupply: bigint): bigint {
  const denom = totalBorrows + totalSupply;
  if (denom === 0n) return 0n;
  return (totalBorrows * WAD) / denom;
}

/** Kinked two-slope annual borrow rate in BPS */
function borrowRateAnnualBps(utilizationWad: bigint, assetIndex: number): bigint {
  const cfg = V1_MARKETS[assetIndex as AssetIndex];
  const optimalWad = BigInt(cfg.optimalUtilization) * WAD / BPS;

  if (utilizationWad <= optimalWad) {
    if (optimalWad === 0n) return BigInt(cfg.baseRate);
    const slope = utilizationWad * BigInt(cfg.slope1) / optimalWad;
    return BigInt(cfg.baseRate) + slope;
  } else {
    const excess = utilizationWad - optimalWad;
    const maxExcess = WAD - optimalWad;
    const excessContrib = excess * BigInt(cfg.slope2) / maxExcess;
    return BigInt(cfg.baseRate) + BigInt(cfg.slope1) + excessContrib;
  }
}

/**
 * Supply rate per second (mirrors calculate_supply_rate in interest.rs).
 * Note: the Rust code passes state.supply_rate_bps as reserve_factor_bps
 * during the supply_compound calculation (step 3 of update_interest_indexes).
 * This function is used for both that calculation AND the rate-recomputation step.
 */
function calculateSupplyRatePerSec(
  borrowRatePerSec: bigint,
  utilizationWad: bigint,
  reserveFactorBps: bigint,
): bigint {
  if (utilizationWad === 0n || borrowRatePerSec === 0n) return 0n;
  const rateXUtil = borrowRatePerSec * utilizationWad / WAD;
  const oneMinusRf = BPS - reserveFactorBps;
  return rateXUtil * oneMinusRf / BPS;
}

function supplyRateAnnualBps(
  borrowRatePerSec: bigint,
  utilizationWad: bigint,
  reserveFactorBps: bigint,
): bigint {
  const supplyPerSec = calculateSupplyRatePerSec(borrowRatePerSec, utilizationWad, reserveFactorBps);
  return supplyPerSec * BPS * SECONDS_PER_YEAR / WAD;
}

/**
 * Accrue interest since last update.
 * Mirrors update_interest_indexes in interest.rs exactly, including the
 * supply_rate_bps passed as reserve_factor in step 3 (faithful to Rust code).
 */
function updateInterestIndexes(
  state: SimInterestState,
  assetIndex: number,
  currentTimestamp: bigint,
): SimInterestState {
  const timeElapsed = currentTimestamp - state.lastUpdateTimestamp;
  if (timeElapsed <= 0n) return state;

  // 1. Accrue borrow index using STORED borrow rate
  const borrowRatePerSec = annualBpsToPerSecondWad(state.borrowRateBps);
  const borrowCompound = calculateCompoundInterest(borrowRatePerSec, timeElapsed);
  const newBorrowIndex = wadMul(state.borrowIndex, borrowCompound);

  // 2. Accrue borrow principal
  const growthWad = borrowCompound - WAD;
  const interestAccrued = wadMul(state.totalBorrows, growthWad);
  const newTotalBorrows = state.totalBorrows + interestAccrued;

  // 3. Accrue supply index
  // Rust code: calculate_supply_rate(borrow_rate_per_sec, new_utilization, state.supply_rate_bps)
  // (passes supply_rate_bps as reserve_factor — faithful replication)
  const newUtilization = calculateUtilization(newTotalBorrows, state.totalSupply);
  const supplyRatePerSec = calculateSupplyRatePerSec(
    borrowRatePerSec,
    newUtilization,
    state.supplyRateBps,  // ← mirrors Rust: state.supply_rate_bps passed as reserve_factor
  );
  const supplyCompound = calculateCompoundInterest(supplyRatePerSec, timeElapsed);
  const newSupplyIndex = wadMul(state.supplyIndex, supplyCompound);

  // 4. Recompute rates for next period (uses correct reserve_factor from config)
  const newBorrowRateBps = borrowRateAnnualBps(newUtilization, assetIndex);
  const newBorrowRatePerSec = annualBpsToPerSecondWad(newBorrowRateBps);
  const reserveFactor = BigInt(V1_MARKETS[assetIndex as AssetIndex].reserveFactor);
  const newSupplyRateBps = supplyRateAnnualBps(newBorrowRatePerSec, newUtilization, reserveFactor);

  return {
    borrowRateBps: newBorrowRateBps,
    supplyRateBps: newSupplyRateBps,
    borrowIndex: newBorrowIndex,
    supplyIndex: newSupplyIndex,
    lastUpdateTimestamp: currentTimestamp,
    totalBorrows: newTotalBorrows,
    totalSupply: state.totalSupply,
  };
}

/** Compute actual debt with accrued interest. */
function getActualDebt(
  principal: bigint,
  userBorrowIndex: bigint,
  currentBorrowIndex: bigint,
): bigint {
  if (principal === 0n) return 0n;
  if (userBorrowIndex === 0n) throw new Error("userBorrowIndex is 0");
  return principal * currentBorrowIndex / userBorrowIndex;
}

/** Scale actual debt back to stored principal at current index. */
function toScaledDebt(amount: bigint, currentBorrowIndex: bigint): bigint {
  if (currentBorrowIndex === 0n) throw new Error("currentBorrowIndex is 0");
  return amount * WAD / currentBorrowIndex;
}

// ── State key helpers ─────────────────────────────────────────────────────────

function stateKey(key: Uint8Array): string {
  return Array.from(key).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Health factor (mirrors health.rs) ─────────────────────────────────────────

const ASSET_DECIMALS = [6, 6, 8] as const;

function assetUsdValue(amount: bigint, priceWad: bigint, decimals: number): bigint {
  // Use explicit exponentiation to avoid any array-indexing type issues
  const divisor = 10n ** BigInt(decimals);
  return amount * (priceWad / divisor);
}

function calculateHF(
  positions: { collateral: bigint; debt: bigint }[],
  prices: bigint[],
): bigint {
  let totalWeightedCol = 0n;
  let totalDebt = 0n;

  for (let i = 0; i < 3; i++) {
    const col = positions[i].collateral;
    const debt = positions[i].debt;
    const price = prices[i];
    const liqThreshold = BigInt(V1_MARKETS[i as AssetIndex].liquidationThreshold);

    if (col > 0n) {
      const colUsd = assetUsdValue(col, price, ASSET_DECIMALS[i]);
      totalWeightedCol += colUsd * liqThreshold / BPS;
    }
    if (debt > 0n) {
      totalDebt += assetUsdValue(debt, price, ASSET_DECIMALS[i]);
    }
  }

  if (totalDebt === 0n) return 2n ** 128n - 1n;
  return totalWeightedCol * WAD / totalDebt;
}

// ── Serialization (mirrors state.rs) ─────────────────────────────────────────

function encodeU128LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  let rem = BigInt.asUintN(128, v);
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return buf;
}

function encodeU64LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let rem = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return buf;
}

function decodeLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// ── SimulatedLedger ───────────────────────────────────────────────────────────

export class SimulatedLedger {
  /** Contract state store: hex(key) → bytes */
  private readonly state = new Map<string, Uint8Array>();
  /** Interest states per asset index */
  private interest: SimInterestState[] = [0, 1, 2].map(() => freshInterestState());
  /** Oracle prices per asset [XRP, RLUSD, wBTC] WAD-scaled */
  private prices: bigint[] = [2n * WAD, WAD, 60_000n * WAD];
  /** Current simulated timestamp (seconds) */
  private timestamp: bigint;

  constructor(initialTimestamp = 1_700_000_000n) {
    this.timestamp = initialTimestamp;
    // Initialise interest state timestamps
    for (let i = 0; i < 3; i++) {
      this.interest[i].lastUpdateTimestamp = initialTimestamp;
    }
  }

  // ── Time & price control ────────────────────────────────────────────────────

  advanceTime(seconds: bigint): void {
    this.timestamp += seconds;
  }

  setOraclePrice(asset: AssetIndex, priceWad: bigint): void {
    this.prices[asset] = priceWad;
  }

  getCurrentTimestamp(): bigint { return this.timestamp; }
  getInterestState(asset: AssetIndex): SimInterestState { return { ...this.interest[asset] }; }

  // ── Contract operations ─────────────────────────────────────────────────────

  /**
   * Supply `amount` native units of `asset` into the lending vault.
   * Mints scaled shares: shares = wadDiv(amount, supplyIndex)
   */
  supply(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;

    // Accrue interest first
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);

    const scaledShares = wadDiv(amount, this.interest[idx].supplyIndex);

    // Update user supply shares
    const sharesKey = stateKey(userPositionKey(accountId, idx, "sh"));
    const existing = this.readU128(sharesKey);
    this.writeU128(sharesKey, existing + scaledShares);

    // Update market total supply
    this.interest[idx].totalSupply += amount;

    this.persistInterest(idx);
  }

  /**
   * Withdraw `shares` scaled shares, redeeming underlying.
   * Amount = wadMul(shares, supplyIndex)
   */
  withdraw(accountAddress: string, asset: AssetIndex, shares: bigint): bigint {
    if (shares === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;

    // Accrue interest
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);

    const sharesKey = stateKey(userPositionKey(accountId, idx, "sh"));
    const userShares = this.readU128(sharesKey);
    if (shares > userShares) throw new Error("WithdrawExceedsBalance");

    const amount = wadMul(shares, this.interest[idx].supplyIndex);
    if (amount > this.interest[idx].totalSupply) throw new Error("InsufficientLiquidity");

    this.writeU128(sharesKey, userShares - shares);
    this.interest[idx].totalSupply -= amount;

    this.persistInterest(idx);
    return amount;
  }

  /**
   * Deposit `amount` native units of `asset` as collateral.
   */
  depositCollateral(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;

    const coKey = stateKey(userPositionKey(accountId, idx, "co"));
    const existing = this.readU128(coKey);
    this.writeU128(coKey, existing + amount);
  }

  /**
   * Withdraw `amount` from collateral — enforces HF ≥ 1.0 after withdrawal.
   */
  withdrawCollateral(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;

    const coKey = stateKey(userPositionKey(accountId, idx, "co"));
    const col = this.readU128(coKey);
    if (amount > col) throw new Error("InsufficientCollateral");

    // Check HF after hypothetical withdrawal
    const positions = this.loadActualPositions(accountId);
    positions[idx].collateral -= amount;
    const hf = calculateHF(positions, this.prices);
    if (hf < WAD) throw new Error("WithdrawWouldLiquidate");

    this.writeU128(coKey, col - amount);
  }

  /**
   * Borrow `amount` native units of `asset`.
   * Checks borrow capacity, merges with existing debt re-normalised to current index.
   */
  borrow(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;

    if (!V1_MARKETS[idx as AssetIndex].borrowEnabled) throw new Error("BorrowNotEnabled");

    // Accrue interest for the borrowed market
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);

    // Compute actual positions with accrued interest
    const actualPositions = this.loadActualPositions(accountId);

    // Check borrow capacity
    let totalWeightedCol = 0n;
    let totalDebtUsd = 0n;
    for (let i = 0; i < 3; i++) {
      const p = actualPositions[i];
      if (p.collateral > 0n) {
        const colUsd = assetUsdValue(p.collateral, this.prices[i], ASSET_DECIMALS[i]);
        totalWeightedCol += colUsd * BigInt(V1_MARKETS[i as AssetIndex].ltv) / BPS;
      }
      if (p.debt > 0n) {
        totalDebtUsd += assetUsdValue(p.debt, this.prices[i], ASSET_DECIMALS[i]);
      }
    }
    const capacity = totalWeightedCol > totalDebtUsd ? totalWeightedCol - totalDebtUsd : 0n;
    const amountUsd = assetUsdValue(amount, this.prices[idx], ASSET_DECIMALS[idx]);
    if (amountUsd > capacity) throw new Error("BorrowCapacityExceeded");

    // Check vault liquidity
    if (amount > this.interest[idx].totalSupply) throw new Error("InsufficientBorrowLiquidity");

    // Merge debt: (existing actual + amount) → scaled at current index
    const existingPrincipal = this.readU128(stateKey(userPositionKey(accountId, idx, "de")));
    const existingUserIndex = this.readU128OrWad(stateKey(userPositionKey(accountId, idx, "bi")));
    const existingActual = getActualDebt(existingPrincipal, existingUserIndex, this.interest[idx].borrowIndex);
    const newActual = existingActual + amount;
    const newPrincipal = toScaledDebt(newActual, this.interest[idx].borrowIndex);

    this.writeU128(stateKey(userPositionKey(accountId, idx, "de")), newPrincipal);
    this.writeU128(stateKey(userPositionKey(accountId, idx, "bi")), this.interest[idx].borrowIndex);

    // Update market totals
    this.interest[idx].totalBorrows += amount;
    this.interest[idx].totalSupply -= amount;

    // Recompute rates based on new utilization (so next period accrues correctly)
    const newUtil = calculateUtilization(this.interest[idx].totalBorrows, this.interest[idx].totalSupply);
    this.interest[idx].borrowRateBps = borrowRateAnnualBps(newUtil, idx);
    const newBorrowRatePerSec = annualBpsToPerSecondWad(this.interest[idx].borrowRateBps);
    const reserveFactor = BigInt(V1_MARKETS[idx as AssetIndex].reserveFactor);
    this.interest[idx].supplyRateBps = supplyRateAnnualBps(newBorrowRatePerSec, newUtil, reserveFactor);

    this.persistInterest(idx);
  }

  /**
   * Repay up to `amount` native units of debt. Excess is "refunded" (tracked as return value).
   * Returns amount actually repaid.
   */
  repay(accountAddress: string, asset: AssetIndex, amount: bigint): bigint {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;

    const deKey = stateKey(userPositionKey(accountId, idx, "de"));
    const biKey = stateKey(userPositionKey(accountId, idx, "bi"));
    const principal = this.readU128(deKey);
    if (principal === 0n) throw new Error("NoBorrowBalance");

    // Accrue interest
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);

    const userBorrowIndex = this.readU128OrWad(biKey);
    const actualDebt = getActualDebt(principal, userBorrowIndex, this.interest[idx].borrowIndex);
    const repayAmount = amount < actualDebt ? amount : actualDebt;

    const remaining = actualDebt - repayAmount;
    if (remaining === 0n) {
      this.writeU128(deKey, 0n);
    } else {
      this.writeU128(deKey, toScaledDebt(remaining, this.interest[idx].borrowIndex));
    }
    this.writeU128(biKey, this.interest[idx].borrowIndex);

    this.interest[idx].totalBorrows =
      this.interest[idx].totalBorrows > repayAmount
        ? this.interest[idx].totalBorrows - repayAmount
        : 0n;
    this.interest[idx].totalSupply += repayAmount;

    this.persistInterest(idx);
    return repayAmount;
  }

  /**
   * Liquidate: repay up to 50% of borrower's debt, seize collateral + bonus.
   * Returns { debtRepaid, collateralSeized, bonus, newHF }
   */
  liquidate(
    liquidatorAddress: string,
    borrowerAddress: string,
    debtAsset: AssetIndex,
    colAsset: AssetIndex,
    amount: bigint,
  ): { debtRepaid: bigint; collateralSeized: bigint; bonus: bigint; newHF: bigint } {
    if (amount === 0n) throw new Error("InvalidAmount");
    if (debtAsset === colAsset) throw new Error("InvalidLiquidation");

    const borrowerAccountId = decodeAccountID(borrowerAddress);
    const liquidatorAccountId = decodeAccountID(liquidatorAddress);
    const d = debtAsset as number;
    const c = colAsset as number;

    // Accrue interest for both markets
    this.interest[d] = updateInterestIndexes(this.interest[d], d, this.timestamp);
    this.interest[c] = updateInterestIndexes(this.interest[c], c, this.timestamp);

    // Compute actual debts
    const actualPositions = this.loadActualPositions(borrowerAccountId);

    // Check HF < 1
    const hf = calculateHF(actualPositions, this.prices);
    if (hf >= WAD) throw new Error("PositionHealthy");

    // Total debt in USD
    let totalDebtUsd = 0n;
    for (let i = 0; i < 3; i++) {
      if (actualPositions[i].debt > 0n) {
        totalDebtUsd += assetUsdValue(actualPositions[i].debt, this.prices[i], ASSET_DECIMALS[i]);
      }
    }

    // 50% close factor cap
    const maxRepayUsd = totalDebtUsd * 5_000n / 10_000n;
    const actualDebtInAsset = actualPositions[d].debt;
    if (actualDebtInAsset === 0n) throw new Error("NoBorrowBalance");

    const amountUsd = assetUsdValue(amount, this.prices[d], ASSET_DECIMALS[d]);
    const debtAssetUsd = assetUsdValue(actualDebtInAsset, this.prices[d], ASSET_DECIMALS[d]);
    const effectiveUsd = amountUsd < maxRepayUsd ? amountUsd : maxRepayUsd;
    const finalEffectiveUsd = effectiveUsd < debtAssetUsd ? effectiveUsd : debtAssetUsd;

    const debtPricePerNative = this.prices[d] / (10n ** BigInt(ASSET_DECIMALS[d]));
    if (debtPricePerNative === 0n) throw new Error("OraclePriceZero");
    const debtRepaid = finalEffectiveUsd / debtPricePerNative;
    if (debtRepaid === 0n) throw new Error("InvalidAmount");

    // Collateral to seize with bonus
    const colPricePerNative = this.prices[c] / (10n ** BigInt(ASSET_DECIMALS[c]));
    if (colPricePerNative === 0n) throw new Error("OraclePriceZero");
    const debtUsd = assetUsdValue(debtRepaid, this.prices[d], ASSET_DECIMALS[d]);
    const baseCollateral = debtUsd / colPricePerNative;
    const bonus = baseCollateral * BigInt(V1_MARKETS[c as AssetIndex].liquidationBonus) / BPS;
    const colToSeize = baseCollateral + bonus;

    if (colToSeize > actualPositions[c].collateral) {
      throw new Error("InsufficientCollateralToSeize");
    }

    // Update borrower: reduce debt
    const remainingDebt = actualDebtInAsset - debtRepaid;
    const deKey = stateKey(userPositionKey(borrowerAccountId, d, "de"));
    const biKey = stateKey(userPositionKey(borrowerAccountId, d, "bi"));
    if (remainingDebt === 0n) {
      this.writeU128(deKey, 0n);
    } else {
      this.writeU128(deKey, toScaledDebt(remainingDebt, this.interest[d].borrowIndex));
    }
    this.writeU128(biKey, this.interest[d].borrowIndex);

    // Update borrower: reduce collateral
    const coKey = stateKey(userPositionKey(borrowerAccountId, c, "co"));
    const borrowerCol = this.readU128(coKey);
    this.writeU128(coKey, borrowerCol - colToSeize);

    // Update liquidator: gain collateral
    const liqCoKey = stateKey(userPositionKey(liquidatorAccountId, c, "co"));
    const liqCol = this.readU128(liqCoKey);
    this.writeU128(liqCoKey, liqCol + colToSeize);

    // Update market totals
    this.interest[d].totalBorrows =
      this.interest[d].totalBorrows > debtRepaid
        ? this.interest[d].totalBorrows - debtRepaid
        : 0n;
    this.interest[d].totalSupply += debtRepaid;

    this.persistInterest(d);
    this.persistInterest(c);

    // Compute new HF
    const postPositions = this.loadActualPositions(borrowerAccountId);
    const newHF = calculateHF(postPositions, this.prices);

    return { debtRepaid, collateralSeized: colToSeize, bonus, newHF };
  }

  // ── SDK-compatible read interface ───────────────────────────────────────────

  /**
   * Create a LendingClient-shaped mock that reads from this SimulatedLedger.
   * The SDK functions (getUserPosition, getDebtBalance, etc.) use this client.
   */
  createClient(accountAddress: string): LendingClientType {
    const self = this;

    const mockXrplClient = {
      request: async (_req: unknown) => ({}),
    };

    return {
      xrplClient: mockXrplClient,
      contractAddress: "rSimulated",
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      setWallet: () => {},
      getWallet: () => { throw new Error("no wallet"); },
      getAccountAddress: () => accountAddress,
      buildInvokeTx: () => ({}),
      submitInvoke: async (_name: string, _args: Uint8Array): Promise<TxResult> => ({
        hash: "SIMULATED",
        validated: true,
        engineResult: "tesSUCCESS",
      }),
      readContractState: async (key: Uint8Array): Promise<Uint8Array | null> => {
        const hexKey = stateKey(key);
        return self.state.get(hexKey) ?? null;
      },
      readOracleLedgerEntry: async (
        _oracleAccount: string,
        _documentId: number,
      ): Promise<Record<string, unknown>> => {
        // Return a DIA-format oracle entry using the simulated prices
        return self.buildOracleEntry();
      },
    } as unknown as LendingClientType;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private readU128(hexKey: string): bigint {
    const bytes = this.state.get(hexKey);
    if (!bytes || bytes.length < 16) return 0n;
    return decodeLE(bytes.slice(0, 16));
  }

  private readU128OrWad(hexKey: string): bigint {
    const bytes = this.state.get(hexKey);
    if (!bytes || bytes.length < 16) return WAD;
    const v = decodeLE(bytes.slice(0, 16));
    return v === 0n ? WAD : v;
  }

  private writeU128(hexKey: string, value: bigint): void {
    this.state.set(hexKey, encodeU128LE(value));
  }

  private writeU64(hexKey: string, value: bigint): void {
    this.state.set(hexKey, encodeU64LE(value));
  }

  private persistInterest(idx: number): void {
    const s = this.interest[idx];
    this.writeU64(stateKey(marketInterestKey(idx, "br")), s.borrowRateBps);
    this.writeU64(stateKey(marketInterestKey(idx, "sr")), s.supplyRateBps);
    this.writeU128(stateKey(marketInterestKey(idx, "bi")), s.borrowIndex);
    this.writeU128(stateKey(marketInterestKey(idx, "si")), s.supplyIndex);
    this.writeU64(stateKey(marketInterestKey(idx, "ts")), s.lastUpdateTimestamp);
    this.writeU128(stateKey(marketInterestKey(idx, "tb")), s.totalBorrows);
    this.writeU128(stateKey(marketInterestKey(idx, "tp")), s.totalSupply);
  }

  /** Load actual (interest-adjusted) positions for an account. */
  private loadActualPositions(
    accountId: Uint8Array,
  ): { collateral: bigint; debt: bigint }[] {
    return [0, 1, 2].map(i => {
      const col = this.readU128(stateKey(userPositionKey(accountId, i, "co")));
      const principal = this.readU128(stateKey(userPositionKey(accountId, i, "de")));
      const userIdx = this.readU128OrWad(stateKey(userPositionKey(accountId, i, "bi")));
      const actualDebt = getActualDebt(principal, userIdx, this.interest[i].borrowIndex);
      return { collateral: col, debt: actualDebt };
    });
  }

  /**
   * Build a mock DIA oracle ledger entry from current simulated prices.
   * Uses scale=-8 to produce prices compatible with rawToWad().
   * rawToWad(assetPrice, -8) = assetPrice × 10^10
   * So to produce priceWad, assetPrice = priceWad / 10^10
   */
  private buildOracleEntry(): Record<string, unknown> {
    const tickers = ["XRP", "RLUSD", "BTC"];
    const series = this.prices.map((priceWad, i) => {
      const assetPrice = priceWad / 10_000_000_000n; // priceWad / 10^10
      return {
        PriceData: {
          BaseAsset: tickers[i],
          QuoteAsset: "USD",
          AssetPrice: assetPrice.toString(),
          Scale: -8,
        },
      };
    });

    return {
      LedgerEntryType: "Oracle",
      LastUpdateTime: Math.floor(Date.now() / 1000),
      PriceDataSeries: series,
    };
  }
}
