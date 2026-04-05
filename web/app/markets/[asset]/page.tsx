"use client";
import { use, useState } from "react";
import Link from "next/link";
import { useMarkets } from "@/lib/hooks/useMarkets";
import { usePrices } from "@/lib/hooks/usePrices";
import { AssetIndex, ASSET_SYMBOLS, ASSET_COLORS, V1_MARKETS } from "@/lib/constants";
import { bpsToPercent, formatUsd, nativeToUsd, utilizationPercent } from "@/lib/format";
import { SupplyDialog } from "@/components/actions/SupplyDialog";
import { BorrowDialog } from "@/components/actions/BorrowDialog";
import { DepositCollateralDialog } from "@/components/actions/DepositCollateralDialog";

type Params = Promise<{ asset: string }>;

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="protocol-card p-4">
      <p className="text-xs text-[#8a8f98] uppercase tracking-wide mb-1">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-[#f7f8f8]">{value}</p>
      {sub && <p className="text-xs text-[#62666d] mt-0.5">{sub}</p>}
    </div>
  );
}

export default function MarketDetailPage({ params }: { params: Params }) {
  const { asset: assetStr } = use(params);
  const asset = parseInt(assetStr, 10) as AssetIndex;
  const { markets, loading } = useMarkets();
  const { prices } = usePrices();
  const [activeDialog, setActiveDialog] = useState<"supply" | "borrow" | "collateral" | null>(null);

  const m = markets[asset];
  const cfg = V1_MARKETS[asset];
  const price = prices[asset];

  if (loading || !m) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-6 w-32 bg-white/[0.06] rounded" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-20 bg-white/[0.03] border border-white/[0.06] rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const supplyUsd = nativeToUsd(m.totalSupply, price, asset);
  const borrowUsd = nativeToUsd(m.totalBorrows, price, asset);
  const util = utilizationPercent(m.totalBorrows, m.totalSupply);
  const priceUsd = Number(price) / 1e18;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/markets" className="text-[#8a8f98] hover:text-[#d0d6e0] text-sm">
          ← Markets
        </Link>
        <span className="text-[#62666d]">/</span>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
            style={{ background: ASSET_COLORS[asset] }}
          >
            {ASSET_SYMBOLS[asset][0]}
          </div>
          <h1 className="text-xl font-semibold text-[#f7f8f8]">{ASSET_SYMBOLS[asset]}</h1>
          <span className="text-sm text-[#8a8f98] tabular-nums">
            ${priceUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Supplied" value={formatUsd(supplyUsd)} />
        <StatCard label="Total Borrowed" value={formatUsd(borrowUsd)} />
        <StatCard label="Supply APY" value={bpsToPercent(m.supplyRateBps)} sub="Earned by suppliers" />
        <StatCard label="Borrow APY" value={bpsToPercent(m.borrowRateBps)} sub="Paid by borrowers" />
      </div>

      {/* Utilization bar */}
      <div className="protocol-card p-5">
        <div className="flex justify-between items-center mb-2">
          <p className="text-xs font-medium text-[#8a8f98] uppercase tracking-wide">Utilization</p>
          <span className="text-sm tabular-nums text-[#f7f8f8]">{util.toFixed(2)}%</span>
        </div>
        <div className="h-3 bg-white/[0.08] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${util}%`,
              background: util > 90 ? "#ef4444" : util > 70 ? "#f59e0b" : "#5e6ad2",
            }}
          />
        </div>
        <div className="flex justify-between text-xs text-[#62666d] mt-1">
          <span>0%</span>
          <span>Optimal {bpsToPercent(cfg.optimalUtilization, 0)}</span>
          <span>100%</span>
        </div>
      </div>

      {/* Risk parameters + Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <h2 className="text-sm font-semibold text-[#8a8f98] uppercase tracking-wide mb-3">Risk Parameters</h2>
          <div className="protocol-card">
            <table className="w-full">
              <tbody>
                {[
                  { label: "LTV", value: bpsToPercent(cfg.ltv, 0), desc: "Max borrow vs collateral" },
                  { label: "Liquidation Threshold", value: bpsToPercent(cfg.liquidationThreshold, 0), desc: "HF drops below 1.0 when breached" },
                  { label: "Liquidation Bonus", value: bpsToPercent(cfg.liquidationBonus, 0), desc: "Reward for liquidators" },
                  { label: "Reserve Factor", value: bpsToPercent(cfg.reserveFactor, 0), desc: "Protocol fee on interest" },
                  { label: "Base Rate", value: bpsToPercent(cfg.baseRate), desc: "Annual rate at 0% utilization" },
                  { label: "Slope 1", value: bpsToPercent(cfg.slope1), desc: "Rate increase below optimal util" },
                  { label: "Slope 2", value: bpsToPercent(cfg.slope2), desc: "Steep increase above optimal util" },
                ].map(row => (
                  <tr key={row.label} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-4 py-2.5 text-sm text-[#8a8f98]">{row.label}</td>
                    <td className="px-4 py-2.5 text-sm tabular-nums font-medium text-[#f7f8f8]">{row.value}</td>
                    <td className="px-4 py-2.5 text-xs text-[#62666d]">{row.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-[#8a8f98] uppercase tracking-wide mb-3">Actions</h2>
          <div className="space-y-2">
            <button
              onClick={() => setActiveDialog("supply")}
              className="w-full px-4 py-3 rounded-lg bg-[#5e6ad2] hover:bg-[#7170ff] text-white text-sm font-medium transition-colors text-left"
            >
              Supply {ASSET_SYMBOLS[asset]}
              <p className="text-xs font-normal text-white/70 mt-0.5">Earn {bpsToPercent(m.supplyRateBps)} APY</p>
            </button>
            <button
              onClick={() => setActiveDialog("collateral")}
              className="w-full px-4 py-3 rounded-lg border border-white/10 hover:bg-white/[0.05] text-[#d0d6e0] text-sm font-medium transition-colors text-left bg-white/[0.02]"
            >
              Deposit as Collateral
              <p className="text-xs font-normal text-[#8a8f98] mt-0.5">Up to {bpsToPercent(cfg.ltv, 0)} LTV</p>
            </button>
            <button
              onClick={() => setActiveDialog("borrow")}
              className="w-full px-4 py-3 rounded-lg border border-white/10 hover:bg-white/[0.05] text-[#d0d6e0] text-sm font-medium transition-colors text-left bg-white/[0.02]"
            >
              Borrow {ASSET_SYMBOLS[asset]}
              <p className="text-xs font-normal text-[#f59e0b] mt-0.5">{bpsToPercent(m.borrowRateBps)} APY cost</p>
            </button>
          </div>
        </div>
      </div>

      {activeDialog === "supply" && (
        <SupplyDialog asset={asset} open onClose={() => setActiveDialog(null)} />
      )}
      {activeDialog === "collateral" && (
        <DepositCollateralDialog asset={asset} open onClose={() => setActiveDialog(null)} />
      )}
      {activeDialog === "borrow" && (
        <BorrowDialog asset={asset} open onClose={() => setActiveDialog(null)} />
      )}
    </div>
  );
}
