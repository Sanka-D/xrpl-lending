/**
 * TypeScript types mirroring the Rust state structs.
 * All WAD-scaled values are represented as bigint (1 WAD = 10n ** 18n).
 * BPS values are plain numbers (7500 = 75%).
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const SECONDS_PER_YEAR = 31_536_000n;

/** V1 asset indices */
export enum AssetIndex {
  XRP = 0,
  RLUSD = 1,
  WBTC = 2,
}

export const ASSET_NAMES: Record<AssetIndex, string> = {
  [AssetIndex.XRP]: "XRP",
  [AssetIndex.RLUSD]: "RLUSD",
  [AssetIndex.WBTC]: "wBTC",
};

// ── MarketConfig ──────────────────────────────────────────────────────────────

/** Risk parameters for one market. Mirrors Rust MarketConfig. */
export interface MarketConfig {
  assetIndex: AssetIndex;
  /** LTV in basis points (7500 = 75%) */
  ltv: number;
  /** Liquidation threshold in bps */
  liquidationThreshold: number;
  /** Liquidation bonus in bps (500 = 5%) */
  liquidationBonus: number;
  /** Reserve factor in bps (2000 = 20%) */
  reserveFactor: number;
  /** Max liquidation per call in bps (5000 = 50%) */
  maxLiquidationBps: number;
  /** Optimal utilization in bps (8000 = 80%) */
  optimalUtilization: number;
  /** Base borrow rate in bps annual */
  baseRate: number;
  /** Slope1: rate increase below optimal util, bps annual */
  slope1: number;
  /** Slope2: rate increase above optimal util, bps annual */
  slope2: number;
  borrowEnabled: boolean;
  collateralEnabled: boolean;
}

/** Hardcoded V1 market parameters (mirror of Rust consts) */
export const V1_MARKETS: Record<AssetIndex, MarketConfig> = {
  [AssetIndex.XRP]: {
    assetIndex: AssetIndex.XRP,
    ltv: 7500,
    liquidationThreshold: 8000,
    liquidationBonus: 500,
    reserveFactor: 2000,
    maxLiquidationBps: 5000,
    optimalUtilization: 8000,
    baseRate: 0,
    slope1: 400,
    slope2: 30000,
    borrowEnabled: true,
    collateralEnabled: true,
  },
  [AssetIndex.RLUSD]: {
    assetIndex: AssetIndex.RLUSD,
    ltv: 8000,
    liquidationThreshold: 8500,
    liquidationBonus: 400,
    reserveFactor: 1000,
    maxLiquidationBps: 5000,
    optimalUtilization: 9000,
    baseRate: 0,
    slope1: 400,
    slope2: 6000,
    borrowEnabled: true,
    collateralEnabled: true,
  },
  [AssetIndex.WBTC]: {
    assetIndex: AssetIndex.WBTC,
    ltv: 7300,
    liquidationThreshold: 7800,
    liquidationBonus: 650,
    reserveFactor: 2000,
    maxLiquidationBps: 5000,
    optimalUtilization: 4500,
    baseRate: 0,
    slope1: 700,
    slope2: 30000,
    borrowEnabled: true,
    collateralEnabled: true,
  },
};

// ── InterestState ─────────────────────────────────────────────────────────────

/** Dynamic interest state for one market. Mirrors Rust InterestState. */
export interface InterestState {
  assetIndex: AssetIndex;
  /** Current borrow rate in bps annual */
  borrowRateBps: number;
  /** Current supply rate in bps annual */
  supplyRateBps: number;
  /** Cumulative borrow index, WAD-scaled */
  borrowIndex: bigint;
  /** Cumulative supply index, WAD-scaled */
  supplyIndex: bigint;
  /** UNIX timestamp of last update (seconds) */
  lastUpdateTimestamp: number;
  /** Total outstanding borrows (native units) */
  totalBorrows: bigint;
  /** Total assets in vault (native units) */
  totalSupply: bigint;
}

// ── UserPosition ──────────────────────────────────────────────────────────────

/** One user's position in one market. */
export interface UserPositionForAsset {
  assetIndex: AssetIndex;
  /** Collateral deposited (native units) */
  collateral: bigint;
  /** Stored debt at borrow time (native units) */
  debt: bigint;
  /** Borrow index snapshot at last borrow/repay */
  userBorrowIndex: bigint;
}

/** Full position across all markets */
export type UserPosition = UserPositionForAsset[];

/** Computed view of a user's health, enriched with prices */
export interface UserHealthView {
  account: string;
  /** Health factor, WAD-scaled (WAD = 1.0, below = liquidatable) */
  healthFactor: bigint;
  /** Total collateral value in USD, WAD-scaled */
  totalCollateralUsd: bigint;
  /** Total debt value in USD, WAD-scaled */
  totalDebtUsd: bigint;
  /** Remaining borrow capacity in USD, WAD-scaled */
  borrowCapacityUsd: bigint;
  positions: UserPositionForAsset[];
}

// ── OracleConfig ──────────────────────────────────────────────────────────────

export interface OracleConfig {
  assetIndex: AssetIndex;
  diaAccount: string;  // r-address
  oracleDocumentId: number;
  maxStaleness: number;  // seconds
  assetTickerHex: string;
  useFixedPrice: boolean;
  fixedPrice: bigint;  // WAD-scaled, only used when useFixedPrice = true
}

/** Price data as read from the DIA oracle on-chain */
export interface OraclePrice {
  assetIndex: AssetIndex;
  priceWad: bigint;        // WAD-scaled USD price
  lastUpdateTime: number;  // UNIX seconds
  isStale: boolean;
}

// ── Contract call payloads ────────────────────────────────────────────────────

/** Base for all ContractCall payloads */
interface BaseContractCall {
  contractAccount: string;  // pseudo-account of the controller
  callerAccount: string;
  fee?: string;             // in XRP drops, default "12"
}

export interface SupplyPayload extends BaseContractCall {
  functionName: "supply";
  assetIndex: AssetIndex;
  /** Amount in native units (drops for XRP, smallest units for others) */
  amount: bigint;
}

export interface WithdrawPayload extends BaseContractCall {
  functionName: "withdraw";
  assetIndex: AssetIndex;
  /** Vault shares to redeem */
  shares: bigint;
}

export interface DepositCollateralPayload extends BaseContractCall {
  functionName: "deposit_collateral";
  assetIndex: AssetIndex;
  amount: bigint;
}

export interface WithdrawCollateralPayload extends BaseContractCall {
  functionName: "withdraw_collateral";
  assetIndex: AssetIndex;
  amount: bigint;
}

export interface BorrowPayload extends BaseContractCall {
  functionName: "borrow";
  assetIndex: AssetIndex;
  amount: bigint;
}

export interface RepayPayload extends BaseContractCall {
  functionName: "repay";
  assetIndex: AssetIndex;
  amount: bigint;
}

export interface LiquidatePayload extends BaseContractCall {
  functionName: "liquidate";
  borrower: string;
  debtAssetIndex: AssetIndex;
  collateralAssetIndex: AssetIndex;
  /** Max debt amount to repay (≤ 50% of outstanding debt) */
  debtAmount: bigint;
}

export type ContractCallPayload =
  | SupplyPayload
  | WithdrawPayload
  | DepositCollateralPayload
  | WithdrawCollateralPayload
  | BorrowPayload
  | RepayPayload
  | LiquidatePayload;

// ── Keeper types ──────────────────────────────────────────────────────────────

export interface LiquidationOpportunity {
  borrower: string;
  healthFactor: bigint;
  debtAsset: AssetIndex;
  collateralAsset: AssetIndex;
  maxDebtToRepay: bigint;    // native units
  collateralToSeize: bigint; // native units including bonus
  /** Estimated profit in USD, WAD-scaled */
  estimatedProfitUsd: bigint;
}

// ── Error handling ────────────────────────────────────────────────────────────

/** Contract error codes mirroring Rust LendingError */
export enum LendingErrorCode {
  MathOverflow = 100,
  InvalidAmount = 101,
  InvalidAsset = 102,
  MarketPaused = 103,
  Unauthorized = 104,
  ContractPaused = 105,
  InsufficientLiquidity = 200,
  VaultNotFound = 201,
  WithdrawExceedsBalance = 202,
  CollateralNotEnabled = 300,
  InsufficientCollateral = 301,
  WithdrawWouldLiquidate = 302,
  BorrowNotEnabled = 400,
  BorrowCapacityExceeded = 401,
  InsufficientBorrowLiquidity = 402,
  RepayExceedsDebt = 403,
  NoBorrowBalance = 404,
  HealthFactorTooLow = 405,
  PositionHealthy = 500,
  MaxLiquidationExceeded = 501,
  InvalidLiquidation = 502,
  InsufficientCollateralToSeize = 503,
  OracleStale = 600,
  OraclePriceZero = 601,
  OracleNotConfigured = 602,
  OracleCircuitBreaker = 603,
  MarketNotConfigured = 800,
  MarketAlreadyExists = 801,
}

export class LendingError extends Error {
  constructor(
    public readonly code: LendingErrorCode,
    message?: string,
  ) {
    super(message ?? `LendingError ${code}`);
    this.name = "LendingError";
  }
}
