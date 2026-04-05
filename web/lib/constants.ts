// V1 protocol constants — inlined to avoid SDK import path issues in the bundler.
// These mirror sdk/src/types.ts and contracts/lending-controller/src/state.rs exactly.

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const SECONDS_PER_YEAR = 31_536_000n;

// ── Asset Index ───────────────────────────────────────────────────────────────

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

// ── Market Configs (V1_MARKETS) ───────────────────────────────────────────────

export interface MarketConfig {
  assetIndex: AssetIndex;
  ltv: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  reserveFactor: number;
  maxLiquidationBps: number;
  optimalUtilization: number;
  baseRate: number;
  slope1: number;
  slope2: number;
  borrowEnabled: boolean;
  collateralEnabled: boolean;
}

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

// ── Display helpers ───────────────────────────────────────────────────────────

export const ASSET_DECIMALS: Record<AssetIndex, number> = {
  [AssetIndex.XRP]: 6,
  [AssetIndex.RLUSD]: 6,
  [AssetIndex.WBTC]: 8,
};

export const ASSET_SYMBOLS: Record<AssetIndex, string> = {
  [AssetIndex.XRP]: "XRP",
  [AssetIndex.RLUSD]: "RLUSD",
  [AssetIndex.WBTC]: "wBTC",
};

export const ASSET_COLORS: Record<AssetIndex, string> = {
  [AssetIndex.XRP]: "#00A8E0",
  [AssetIndex.RLUSD]: "#2FC18C",
  [AssetIndex.WBTC]: "#F7931A",
};

export const ASSET_UNIT: Record<AssetIndex, bigint> = {
  [AssetIndex.XRP]: 1_000_000n,
  [AssetIndex.RLUSD]: 1_000_000n,
  [AssetIndex.WBTC]: 100_000_000n,
};

export const ASSETS = [AssetIndex.XRP, AssetIndex.RLUSD, AssetIndex.WBTC] as const;

// ── State key helpers (mirror state.rs) ──────────────────────────────────────

/** mkt:{i}:int:{field} as bytes */
export function marketInterestKey(assetIndex: number, field: string): Uint8Array {
  const prefix = `mkt:${assetIndex}:int:`;
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(prefix);
  const fieldBytes = enc.encode(field);
  const result = new Uint8Array(prefixBytes.length + fieldBytes.length);
  result.set(prefixBytes);
  result.set(fieldBytes, prefixBytes.length);
  return result;
}

/** pos:{20-byte accountId}:{i}:{field} as bytes */
export function userPositionKey(accountId: Uint8Array, assetIndex: number, field: string): Uint8Array {
  const prefix = "pos:";
  const suffix = `:${assetIndex}:${field}`;
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(prefix);
  const suffixBytes = enc.encode(suffix);
  const result = new Uint8Array(prefixBytes.length + 20 + suffixBytes.length);
  result.set(prefixBytes, 0);
  result.set(accountId.slice(0, 20), prefixBytes.length);
  result.set(suffixBytes, prefixBytes.length + 20);
  return result;
}
