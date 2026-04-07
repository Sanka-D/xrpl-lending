export interface AtlasMarket {
  id: string;
  name: string;
  asset: string;
  assetDecimals: number;
  totalSupply: bigint;
  totalBorrows: bigint;
  supplyAPY: number;
  borrowAPY: number;
  utilization: number;
  ltv: number;
  liquidationThreshold: number;
}

const priceEstimates: Record<string, number> = {
  XRP: 2.15,
  RLUSD: 1.0,
  WBTC: 65000,
};

export { priceEstimates };

export const ATLAS_MARKETS: AtlasMarket[] = [
  {
    id: "xrp-market",
    name: "XRP Lending Pool",
    asset: "XRP",
    assetDecimals: 6,
    totalSupply: 2_500_000_000_000n,
    totalBorrows: 800_000_000_000n,
    supplyAPY: 3.42,
    borrowAPY: 5.18,
    utilization: 32,
    ltv: 75,
    liquidationThreshold: 80,
  },
  {
    id: "rlusd-market",
    name: "RLUSD Lending Pool",
    asset: "RLUSD",
    assetDecimals: 6,
    totalSupply: 5_000_000_000_000n,
    totalBorrows: 2_100_000_000_000n,
    supplyAPY: 4.85,
    borrowAPY: 6.92,
    utilization: 42,
    ltv: 80,
    liquidationThreshold: 85,
  },
  {
    id: "wbtc-market",
    name: "WBTC Lending Pool",
    asset: "WBTC",
    assetDecimals: 8,
    totalSupply: 50_00000000n,
    totalBorrows: 15_00000000n,
    supplyAPY: 1.23,
    borrowAPY: 3.45,
    utilization: 30,
    ltv: 70,
    liquidationThreshold: 75,
  },
];

export const TOKEN_LOGOS: Record<string, string> = {
  XRP: "/logos/xrp.png",
  RLUSD: "/logos/rlusd.webp",
  WBTC: "/logos/btc.svg",
};

export const TOKEN_COLORS: Record<string, string> = {
  XRP: "bg-gray-400",
  RLUSD: "bg-emerald-500",
  WBTC: "bg-orange-500",
};
