"use client";

import { Card, CardContent } from "@/components/ui/card";
import { type AtlasMarket, priceEstimates } from "@/config/markets";
import { formatUSD } from "@/lib/format";

interface MarketStatsProps {
  markets: AtlasMarket[];
}

export function MarketStats({ markets }: MarketStatsProps) {
  let totalTVL = 0;
  let totalBorrowed = 0;
  let avgSupplyAPY = 0;
  let weightedAPYDenom = 0;

  for (const m of markets) {
    const price = priceEstimates[m.asset] ?? 1;
    const divisor = Math.pow(10, m.assetDecimals);
    const tvl = (Number(m.totalSupply) / divisor) * price;
    const borrowed = (Number(m.totalBorrows) / divisor) * price;

    totalTVL += tvl;
    totalBorrowed += borrowed;

    if (tvl > 0) {
      avgSupplyAPY += m.supplyAPY * tvl;
      weightedAPYDenom += tvl;
    }
  }

  const weightedAvgAPY = weightedAPYDenom > 0 ? avgSupplyAPY / weightedAPYDenom : 0;

  const stats = [
    {
      label: "Total Value Locked",
      value: formatUSD(totalTVL),
      subtext: `${markets.length} markets`,
    },
    {
      label: "Total Borrowed",
      value: formatUSD(totalBorrowed),
      subtext: `${((totalBorrowed / (totalTVL || 1)) * 100).toFixed(1)}% utilization`,
    },
    {
      label: "Available Liquidity",
      value: formatUSD(totalTVL - totalBorrowed),
      subtext: "across all markets",
    },
    {
      label: "Avg Supply APY",
      value: `${weightedAvgAPY.toFixed(2)}%`,
      subtext: "weighted by TVL",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <Card key={stat.label} className="border-border/40 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="text-2xl font-semibold tracking-tight mt-1">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{stat.subtext}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
