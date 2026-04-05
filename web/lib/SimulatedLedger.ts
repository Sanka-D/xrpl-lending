"use client";
/**
 * SimulatedLedger — browser-safe copy of tests/helpers/simulated-ledger.ts.
 * Uses only the `xrpl` package (for base58 account encoding) + local constants.
 * Mirrors the Rust contract logic exactly.
 */
import { encodeAccountID, decodeAccountID } from "xrpl";
import {
  AssetIndex, V1_MARKETS, WAD, ASSET_DECIMALS,
  marketInterestKey, userPositionKey,
} from "./constants";

// ── WAD Math ──────────────────────────────────────────────────────────────────

const HALF_WAD = WAD / 2n;
const BPS = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;

function wadMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a * b + HALF_WAD) / WAD;
}

function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("wadDiv: division by zero");
  return (a * WAD + b / 2n) / b;
}

function annualBpsToPerSecondWad(annualBps: bigint): bigint {
  return (annualBps * WAD) / (BPS * SECONDS_PER_YEAR);
}

function calculateCompoundInterest(ratePerSec: bigint, duration: bigint): bigint {
  if (duration === 0n) return WAD;
  const rt = ratePerSec * duration;
  if (duration === 1n) return WAD + rt;
  const rtSquared = wadMul(rt, rt);
  return WAD + rt + rtSquared / 2n;
}

// ── Interest State ─────────────────────────────────────────────────────────────

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
    borrowRateBps: 0n, supplyRateBps: 0n,
    borrowIndex: WAD, supplyIndex: WAD,
    lastUpdateTimestamp: 0n, totalBorrows: 0n, totalSupply: 0n,
  };
}

function calculateUtilization(totalBorrows: bigint, totalSupply: bigint): bigint {
  const denom = totalBorrows + totalSupply;
  if (denom === 0n) return 0n;
  return (totalBorrows * WAD) / denom;
}

function borrowRateAnnualBps(utilizationWad: bigint, assetIndex: number): bigint {
  const cfg = V1_MARKETS[assetIndex as AssetIndex];
  const optimalWad = BigInt(cfg.optimalUtilization) * WAD / BPS;
  if (utilizationWad <= optimalWad) {
    if (optimalWad === 0n) return BigInt(cfg.baseRate);
    return BigInt(cfg.baseRate) + utilizationWad * BigInt(cfg.slope1) / optimalWad;
  }
  const excess = utilizationWad - optimalWad;
  const maxExcess = WAD - optimalWad;
  return BigInt(cfg.baseRate) + BigInt(cfg.slope1) + excess * BigInt(cfg.slope2) / maxExcess;
}

function calculateSupplyRatePerSec(borrowRatePerSec: bigint, utilizationWad: bigint, reserveFactorBps: bigint): bigint {
  if (utilizationWad === 0n || borrowRatePerSec === 0n) return 0n;
  const rateXUtil = borrowRatePerSec * utilizationWad / WAD;
  return rateXUtil * (BPS - reserveFactorBps) / BPS;
}

function supplyRateAnnualBps(borrowRatePerSec: bigint, utilizationWad: bigint, reserveFactorBps: bigint): bigint {
  return calculateSupplyRatePerSec(borrowRatePerSec, utilizationWad, reserveFactorBps) * BPS * SECONDS_PER_YEAR / WAD;
}

function updateInterestIndexes(state: SimInterestState, assetIndex: number, currentTimestamp: bigint): SimInterestState {
  const timeElapsed = currentTimestamp - state.lastUpdateTimestamp;
  if (timeElapsed <= 0n) return state;
  const borrowRatePerSec = annualBpsToPerSecondWad(state.borrowRateBps);
  const borrowCompound = calculateCompoundInterest(borrowRatePerSec, timeElapsed);
  const newBorrowIndex = wadMul(state.borrowIndex, borrowCompound);
  const interestAccrued = wadMul(state.totalBorrows, borrowCompound - WAD);
  const newTotalBorrows = state.totalBorrows + interestAccrued;
  const newUtilization = calculateUtilization(newTotalBorrows, state.totalSupply);
  const supplyRatePerSec = calculateSupplyRatePerSec(borrowRatePerSec, newUtilization, state.supplyRateBps);
  const newSupplyIndex = wadMul(state.supplyIndex, calculateCompoundInterest(supplyRatePerSec, timeElapsed));
  const newBorrowRateBps = borrowRateAnnualBps(newUtilization, assetIndex);
  const newBorrowRatePerSec2 = annualBpsToPerSecondWad(newBorrowRateBps);
  const reserveFactor = BigInt(V1_MARKETS[assetIndex as AssetIndex].reserveFactor);
  return {
    borrowRateBps: newBorrowRateBps,
    supplyRateBps: supplyRateAnnualBps(newBorrowRatePerSec2, newUtilization, reserveFactor),
    borrowIndex: newBorrowIndex,
    supplyIndex: newSupplyIndex,
    lastUpdateTimestamp: currentTimestamp,
    totalBorrows: newTotalBorrows,
    totalSupply: state.totalSupply,
  };
}

function getActualDebt(principal: bigint, userBorrowIndex: bigint, currentBorrowIndex: bigint): bigint {
  if (principal === 0n) return 0n;
  if (userBorrowIndex === 0n) throw new Error("userBorrowIndex is 0");
  return principal * currentBorrowIndex / userBorrowIndex;
}

function toScaledDebt(amount: bigint, currentBorrowIndex: bigint): bigint {
  return amount * WAD / currentBorrowIndex;
}

// ── State key helpers ─────────────────────────────────────────────────────────

function hexKey(key: Uint8Array): string {
  return Array.from(key).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── HF ────────────────────────────────────────────────────────────────────────

function assetUsdValue(amount: bigint, priceWad: bigint, decimals: number): bigint {
  const divisor = 10n ** BigInt(decimals);
  return amount * (priceWad / divisor);
}

function calculateHF(positions: { collateral: bigint; debt: bigint }[], prices: bigint[]): bigint {
  let totalWeightedCol = 0n;
  let totalDebt = 0n;
  for (let i = 0; i < 3; i++) {
    const { collateral: col, debt } = positions[i];
    const price = prices[i];
    const liqThreshold = BigInt(V1_MARKETS[i as AssetIndex].liquidationThreshold);
    if (col > 0n) totalWeightedCol += assetUsdValue(col, price, ASSET_DECIMALS[i as AssetIndex]) * liqThreshold / BPS;
    if (debt > 0n) totalDebt += assetUsdValue(debt, price, ASSET_DECIMALS[i as AssetIndex]);
  }
  if (totalDebt === 0n) return 2n ** 128n - 1n;
  return totalWeightedCol * WAD / totalDebt;
}

// ── Encoding ──────────────────────────────────────────────────────────────────

function encodeU128LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  let rem = BigInt.asUintN(128, v);
  for (let i = 0; i < 16; i++) { buf[i] = Number(rem & 0xffn); rem >>= 8n; }
  return buf;
}

function encodeU64LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let rem = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) { buf[i] = Number(rem & 0xffn); rem >>= 8n; }
  return buf;
}

function decodeLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i]);
  return result;
}

// ── SimulatedLedger ───────────────────────────────────────────────────────────

export class SimulatedLedger {
  private readonly state = new Map<string, Uint8Array>();
  private interest: SimInterestState[] = [0, 1, 2].map(() => freshInterestState());
  private prices: bigint[] = [2n * WAD, WAD, 60_000n * WAD];
  private timestamp: bigint;

  constructor(initialTimestamp = 1_700_000_000n) {
    this.timestamp = initialTimestamp;
    for (let i = 0; i < 3; i++) this.interest[i].lastUpdateTimestamp = initialTimestamp;
  }

  advanceTime(seconds: bigint): void { this.timestamp += seconds; }
  setOraclePrice(asset: AssetIndex, priceWad: bigint): void { this.prices[asset] = priceWad; }
  getCurrentTimestamp(): bigint { return this.timestamp; }
  getInterestState(asset: AssetIndex): SimInterestState { return { ...this.interest[asset] }; }
  getPrices(): bigint[] { return [...this.prices]; }

  supply(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);
    const scaledShares = wadDiv(amount, this.interest[idx].supplyIndex);
    const sharesKey = hexKey(userPositionKey(accountId, idx, "sh"));
    this.writeU128(sharesKey, this.readU128(sharesKey) + scaledShares);
    this.interest[idx].totalSupply += amount;
    this.persistInterest(idx);
  }

  withdraw(accountAddress: string, asset: AssetIndex, shares: bigint): bigint {
    if (shares === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);
    const sharesKey = hexKey(userPositionKey(accountId, idx, "sh"));
    const userShares = this.readU128(sharesKey);
    if (shares > userShares) throw new Error("WithdrawExceedsBalance");
    const amount = wadMul(shares, this.interest[idx].supplyIndex);
    if (amount > this.interest[idx].totalSupply) throw new Error("InsufficientLiquidity");
    this.writeU128(sharesKey, userShares - shares);
    this.interest[idx].totalSupply -= amount;
    this.persistInterest(idx);
    return amount;
  }

  depositCollateral(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;
    const coKey = hexKey(userPositionKey(accountId, idx, "co"));
    this.writeU128(coKey, this.readU128(coKey) + amount);
  }

  withdrawCollateral(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;
    const coKey = hexKey(userPositionKey(accountId, idx, "co"));
    const col = this.readU128(coKey);
    if (amount > col) throw new Error("InsufficientCollateral");
    const positions = this.loadActualPositions(accountId);
    positions[idx].collateral -= amount;
    if (calculateHF(positions, this.prices) < WAD) throw new Error("WithdrawWouldLiquidate");
    this.writeU128(coKey, col - amount);
  }

  borrow(accountAddress: string, asset: AssetIndex, amount: bigint): void {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;
    if (!V1_MARKETS[idx as AssetIndex].borrowEnabled) throw new Error("BorrowNotEnabled");
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);
    const actualPositions = this.loadActualPositions(accountId);
    let totalWeightedCol = 0n;
    let totalDebtUsd = 0n;
    for (let i = 0; i < 3; i++) {
      if (actualPositions[i].collateral > 0n) {
        totalWeightedCol += assetUsdValue(actualPositions[i].collateral, this.prices[i], ASSET_DECIMALS[i as AssetIndex])
          * BigInt(V1_MARKETS[i as AssetIndex].ltv) / BPS;
      }
      if (actualPositions[i].debt > 0n) {
        totalDebtUsd += assetUsdValue(actualPositions[i].debt, this.prices[i], ASSET_DECIMALS[i as AssetIndex]);
      }
    }
    const capacity = totalWeightedCol > totalDebtUsd ? totalWeightedCol - totalDebtUsd : 0n;
    if (assetUsdValue(amount, this.prices[idx], ASSET_DECIMALS[idx as AssetIndex]) > capacity) throw new Error("BorrowCapacityExceeded");
    if (amount > this.interest[idx].totalSupply) throw new Error("InsufficientBorrowLiquidity");
    const existingPrincipal = this.readU128(hexKey(userPositionKey(accountId, idx, "de")));
    const existingUserIndex = this.readU128OrWad(hexKey(userPositionKey(accountId, idx, "bi")));
    const existingActual = getActualDebt(existingPrincipal, existingUserIndex, this.interest[idx].borrowIndex);
    const newPrincipal = toScaledDebt(existingActual + amount, this.interest[idx].borrowIndex);
    this.writeU128(hexKey(userPositionKey(accountId, idx, "de")), newPrincipal);
    this.writeU128(hexKey(userPositionKey(accountId, idx, "bi")), this.interest[idx].borrowIndex);
    this.interest[idx].totalBorrows += amount;
    this.interest[idx].totalSupply -= amount;
    const newUtil = calculateUtilization(this.interest[idx].totalBorrows, this.interest[idx].totalSupply);
    this.interest[idx].borrowRateBps = borrowRateAnnualBps(newUtil, idx);
    const newBorrowRatePerSec = annualBpsToPerSecondWad(this.interest[idx].borrowRateBps);
    const reserveFactor = BigInt(V1_MARKETS[idx as AssetIndex].reserveFactor);
    this.interest[idx].supplyRateBps = supplyRateAnnualBps(newBorrowRatePerSec, newUtil, reserveFactor);
    this.persistInterest(idx);
  }

  repay(accountAddress: string, asset: AssetIndex, amount: bigint): bigint {
    if (amount === 0n) throw new Error("InvalidAmount");
    const accountId = decodeAccountID(accountAddress);
    const idx = asset as number;
    const deKey = hexKey(userPositionKey(accountId, idx, "de"));
    const biKey = hexKey(userPositionKey(accountId, idx, "bi"));
    const principal = this.readU128(deKey);
    if (principal === 0n) throw new Error("NoBorrowBalance");
    this.interest[idx] = updateInterestIndexes(this.interest[idx], idx, this.timestamp);
    const actualDebt = getActualDebt(principal, this.readU128OrWad(biKey), this.interest[idx].borrowIndex);
    const repayAmount = amount < actualDebt ? amount : actualDebt;
    const remaining = actualDebt - repayAmount;
    this.writeU128(deKey, remaining === 0n ? 0n : toScaledDebt(remaining, this.interest[idx].borrowIndex));
    this.writeU128(biKey, this.interest[idx].borrowIndex);
    this.interest[idx].totalBorrows = this.interest[idx].totalBorrows > repayAmount
      ? this.interest[idx].totalBorrows - repayAmount : 0n;
    this.interest[idx].totalSupply += repayAmount;
    this.persistInterest(idx);
    return repayAmount;
  }

  liquidate(
    liquidatorAddress: string, borrowerAddress: string,
    debtAsset: AssetIndex, colAsset: AssetIndex, amount: bigint,
  ): { debtRepaid: bigint; collateralSeized: bigint; bonus: bigint; newHF: bigint } {
    if (amount === 0n) throw new Error("InvalidAmount");
    const borrowerAccountId = decodeAccountID(borrowerAddress);
    const liquidatorAccountId = decodeAccountID(liquidatorAddress);
    const d = debtAsset as number;
    const c = colAsset as number;
    this.interest[d] = updateInterestIndexes(this.interest[d], d, this.timestamp);
    this.interest[c] = updateInterestIndexes(this.interest[c], c, this.timestamp);
    const actualPositions = this.loadActualPositions(borrowerAccountId);
    if (calculateHF(actualPositions, this.prices) >= WAD) throw new Error("PositionHealthy");
    let totalDebtUsd = 0n;
    for (let i = 0; i < 3; i++) {
      if (actualPositions[i].debt > 0n)
        totalDebtUsd += assetUsdValue(actualPositions[i].debt, this.prices[i], ASSET_DECIMALS[i as AssetIndex]);
    }
    const maxRepayUsd = totalDebtUsd * 5_000n / 10_000n;
    const actualDebtInAsset = actualPositions[d].debt;
    if (actualDebtInAsset === 0n) throw new Error("NoBorrowBalance");
    const amountUsd = assetUsdValue(amount, this.prices[d], ASSET_DECIMALS[d as AssetIndex]);
    const debtAssetUsd = assetUsdValue(actualDebtInAsset, this.prices[d], ASSET_DECIMALS[d as AssetIndex]);
    const effectiveUsd = amountUsd < maxRepayUsd ? amountUsd : maxRepayUsd;
    const finalEffectiveUsd = effectiveUsd < debtAssetUsd ? effectiveUsd : debtAssetUsd;
    const debtPricePerNative = this.prices[d] / (10n ** BigInt(ASSET_DECIMALS[d as AssetIndex]));
    if (debtPricePerNative === 0n) throw new Error("OraclePriceZero");
    const debtRepaid = finalEffectiveUsd / debtPricePerNative;
    if (debtRepaid === 0n) throw new Error("InvalidAmount");
    const colPricePerNative = this.prices[c] / (10n ** BigInt(ASSET_DECIMALS[c as AssetIndex]));
    if (colPricePerNative === 0n) throw new Error("OraclePriceZero");
    const debtUsd = assetUsdValue(debtRepaid, this.prices[d], ASSET_DECIMALS[d as AssetIndex]);
    const baseCollateral = debtUsd / colPricePerNative;
    const bonus = baseCollateral * BigInt(V1_MARKETS[c as AssetIndex].liquidationBonus) / BPS;
    const colToSeize = baseCollateral + bonus;
    if (colToSeize > actualPositions[c].collateral) throw new Error("InsufficientCollateralToSeize");
    const remainingDebt = actualDebtInAsset - debtRepaid;
    const deKey = hexKey(userPositionKey(borrowerAccountId, d, "de"));
    const biKey = hexKey(userPositionKey(borrowerAccountId, d, "bi"));
    this.writeU128(deKey, remainingDebt === 0n ? 0n : toScaledDebt(remainingDebt, this.interest[d].borrowIndex));
    this.writeU128(biKey, this.interest[d].borrowIndex);
    const coKey = hexKey(userPositionKey(borrowerAccountId, c, "co"));
    this.writeU128(coKey, this.readU128(coKey) - colToSeize);
    const liqCoKey = hexKey(userPositionKey(liquidatorAccountId, c, "co"));
    this.writeU128(liqCoKey, this.readU128(liqCoKey) + colToSeize);
    this.interest[d].totalBorrows = this.interest[d].totalBorrows > debtRepaid
      ? this.interest[d].totalBorrows - debtRepaid : 0n;
    this.interest[d].totalSupply += debtRepaid;
    this.persistInterest(d);
    this.persistInterest(c);
    return { debtRepaid, collateralSeized: colToSeize, bonus, newHF: calculateHF(this.loadActualPositions(borrowerAccountId), this.prices) };
  }

  /** Read raw state by hex key — used by SimulatedProvider */
  readState(keyBytes: Uint8Array): Uint8Array | null {
    return this.state.get(hexKey(keyBytes)) ?? null;
  }

  /** Read user supply shares for asset */
  getUserShares(accountAddress: string, asset: AssetIndex): bigint {
    const accountId = decodeAccountID(accountAddress);
    return this.readU128(hexKey(userPositionKey(accountId, asset as number, "sh")));
  }

  /** Read user collateral for asset */
  getUserCollateral(accountAddress: string, asset: AssetIndex): bigint {
    const accountId = decodeAccountID(accountAddress);
    return this.readU128(hexKey(userPositionKey(accountId, asset as number, "co")));
  }

  /** Read user debt principal for asset */
  getUserDebtPrincipal(accountAddress: string, asset: AssetIndex): bigint {
    const accountId = decodeAccountID(accountAddress);
    return this.readU128(hexKey(userPositionKey(accountId, asset as number, "de")));
  }

  /** Read user borrow index for asset */
  getUserBorrowIndex(accountAddress: string, asset: AssetIndex): bigint {
    const accountId = decodeAccountID(accountAddress);
    return this.readU128OrWad(hexKey(userPositionKey(accountId, asset as number, "bi")));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private readU128(k: string): bigint {
    const bytes = this.state.get(k);
    return bytes && bytes.length >= 16 ? decodeLE(bytes.slice(0, 16)) : 0n;
  }

  private readU128OrWad(k: string): bigint {
    const v = this.readU128(k);
    return v === 0n ? WAD : v;
  }

  private writeU128(k: string, v: bigint): void { this.state.set(k, encodeU128LE(v)); }

  private persistInterest(idx: number): void {
    const s = this.interest[idx];
    this.writeU128(hexKey(marketInterestKey(idx, "bi")), s.borrowIndex);
    this.writeU128(hexKey(marketInterestKey(idx, "si")), s.supplyIndex);
    this.writeU128(hexKey(marketInterestKey(idx, "tb")), s.totalBorrows);
    this.writeU128(hexKey(marketInterestKey(idx, "tp")), s.totalSupply);
    this.state.set(hexKey(marketInterestKey(idx, "br")), encodeU64LE(s.borrowRateBps));
    this.state.set(hexKey(marketInterestKey(idx, "sr")), encodeU64LE(s.supplyRateBps));
    this.state.set(hexKey(marketInterestKey(idx, "ts")), encodeU64LE(s.lastUpdateTimestamp));
  }

  private loadActualPositions(accountId: Uint8Array): { collateral: bigint; debt: bigint }[] {
    return [0, 1, 2].map(i => {
      const col = this.readU128(hexKey(userPositionKey(accountId, i, "co")));
      const principal = this.readU128(hexKey(userPositionKey(accountId, i, "de")));
      const userIdx = this.readU128OrWad(hexKey(userPositionKey(accountId, i, "bi")));
      return { collateral: col, debt: getActualDebt(principal, userIdx, this.interest[i].borrowIndex) };
    });
  }
}
