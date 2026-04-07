"use client";

import { ATLAS_MARKETS } from "@/config/markets";
import { MarketTable } from "@/components/markets/MarketTable";
import { MarketStats } from "@/components/markets/MarketStats";

export default function MarketsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Explore lending markets on the XRP Ledger
        </p>
      </div>

      <MarketStats markets={ATLAS_MARKETS} />

      <MarketTable markets={ATLAS_MARKETS} />
    </div>
  );
}
