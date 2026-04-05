"use client";
import { useState } from "react";
import Link from "next/link";
import { useMarkets } from "@/lib/hooks/useMarkets";
import { usePrices } from "@/lib/hooks/usePrices";
import { ASSET_SYMBOLS, ASSET_COLORS, ASSETS, AssetIndex } from "@/lib/constants";
import { bpsToPercent, formatUsd, nativeToUsd, utilizationPercent } from "@/lib/format";
import { SupplyDialog } from "@/components/actions/SupplyDialog";
import { DepositCollateralDialog } from "@/components/actions/DepositCollateralDialog";

type DialogInfo = { type: "supply" | "collateral"; asset: AssetIndex } | null;

export default function MarketsPage() {
  const { markets, loading } = useMarkets();
  const { prices } = usePrices();
  const [dialog, setDialog] = useState<DialogInfo>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#f7f8f8]">Markets</h1>
        <p className="text-sm text-[#8a8f98] mt-0.5">Available lending markets — 3 assets</p>
      </div>

      {loading ? (
        <div className="h-48 bg-white/[0.03] border border-white/[0.06] rounded-lg animate-pulse" />
      ) : (
        <div className="protocol-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.08]">
                {["Asset", "Total Supplied", "Supply APY", "Total Borrowed", "Borrow APY", "Utilization", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-[#8a8f98] uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ASSETS.map(idx => {
                const m = markets[idx];
                if (!m) return null;
                const price = prices[idx];
                const supplyUsd = nativeToUsd(m.totalSupply, price, idx);
                const borrowUsd = nativeToUsd(m.totalBorrows, price, idx);
                const util = utilizationPercent(m.totalBorrows, m.totalSupply);
                return (
                  <tr key={idx} className="border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors">
                    <td className="px-4 py-4">
                      <Link href={`/markets/${idx}`} className="flex items-center gap-2.5 group">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                          style={{ background: ASSET_COLORS[idx] }}
                        >
                          {ASSET_SYMBOLS[idx][0]}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[#f7f8f8] group-hover:text-[#7170ff] transition-colors">
                            {ASSET_SYMBOLS[idx]}
                          </p>
                          <p className="text-xs text-[#62666d]">
                            ${(Number(price) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                          </p>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-4 text-sm tabular-nums text-[#d0d6e0]">{formatUsd(supplyUsd)}</td>
                    <td className="px-4 py-4 text-sm tabular-nums text-[#10b981] font-medium">
                      {bpsToPercent(m.supplyRateBps)}
                    </td>
                    <td className="px-4 py-4 text-sm tabular-nums text-[#d0d6e0]">{formatUsd(borrowUsd)}</td>
                    <td className="px-4 py-4 text-sm tabular-nums text-[#f59e0b] font-medium">
                      {bpsToPercent(m.borrowRateBps)}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${util}%`,
                              background: util > 90 ? "#ef4444" : util > 70 ? "#f59e0b" : "#5e6ad2",
                            }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-[#8a8f98]">{util.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <button
                          onClick={() => setDialog({ type: "supply", asset: idx })}
                          className="px-3 py-1 text-xs font-medium rounded-md bg-[#5e6ad2] hover:bg-[#7170ff] text-white transition-colors"
                        >
                          Supply
                        </button>
                        <button
                          onClick={() => setDialog({ type: "collateral", asset: idx })}
                          className="px-3 py-1 text-xs font-medium rounded-md border border-white/10 text-[#d0d6e0] hover:bg-white/[0.05] transition-colors"
                        >
                          Collateral
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.type === "supply" && (
        <SupplyDialog asset={dialog.asset} open onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "collateral" && (
        <DepositCollateralDialog asset={dialog.asset} open onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
