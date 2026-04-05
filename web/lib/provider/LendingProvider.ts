import type { AssetIndex } from "../constants";

// ── Market data ───────────────────────────────────────────────────────────────

export interface MarketState {
  assetIndex: AssetIndex;
  totalSupply: bigint;       // native units
  totalBorrows: bigint;      // native units
  supplyRateBps: number;     // annual supply APY in bps
  borrowRateBps: number;     // annual borrow APY in bps
  borrowIndex: bigint;       // WAD-scaled
  supplyIndex: bigint;       // WAD-scaled
  ltv: number;               // bps
  liquidationThreshold: number; // bps
  liquidationBonus: number;  // bps
  reserveFactor: number;     // bps
  optimalUtilization: number; // bps
}

export interface UserAssetPosition {
  assetIndex: AssetIndex;
  supplyShares: bigint;      // scaled supply shares
  supplyAmount: bigint;      // current underlying value (shares × supplyIndex / WAD)
  collateral: bigint;        // native units deposited as collateral
  debtPrincipal: bigint;     // scaled principal stored
  debtAmount: bigint;        // actual debt with accrued interest
}

export interface UserPositionView {
  address: string;
  positions: UserAssetPosition[];
  healthFactor: bigint;      // WAD-scaled, 2^128-1 when no debt
  totalCollateralUsd: number;
  totalDebtUsd: number;
  netWorthUsd: number;
  borrowCapacityUsd: number;
}

export interface Prices {
  [AssetIndex.XRP]: bigint;   // WAD-scaled USD price
  [AssetIndex.RLUSD]: bigint;
  [AssetIndex.WBTC]: bigint;
}

export interface LiquidatablePosition {
  borrowerAddress: string;
  healthFactor: bigint;
  totalDebtUsd: number;
  totalCollateralUsd: number;
  /** Best debt asset to repay */
  debtAsset: AssetIndex;
  /** Best collateral asset to seize */
  colAsset: AssetIndex;
  maxRepayAmount: bigint;
  estimatedBonus: number; // USD
}

export interface TxResult {
  hash: string;
  validated: boolean;
  engineResult: string;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ILendingProvider {
  /** Fetch all 3 markets' current state */
  getMarkets(): Promise<MarketState[]>;

  /** Fetch position for connected user */
  getPosition(address: string): Promise<UserPositionView>;

  /** Fetch oracle prices */
  getPrices(): Promise<Prices>;

  /** Positions with HF < 1 (liquidatable) */
  getLiquidatablePositions(): Promise<LiquidatablePosition[]>;

  // ── Write operations (require signer) ──────────────────────────────────────

  supply(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult>;
  withdraw(address: string, asset: AssetIndex, shares: bigint): Promise<TxResult>;
  depositCollateral(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult>;
  withdrawCollateral(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult>;
  borrow(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult>;
  repay(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult>;
  liquidate(
    liquidatorAddress: string,
    borrowerAddress: string,
    debtAsset: AssetIndex,
    colAsset: AssetIndex,
    amount: bigint,
  ): Promise<TxResult>;
}
