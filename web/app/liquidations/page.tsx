"use client";
import { useState, useEffect, useCallback } from "react";
import { useLendingProvider } from "@/lib/provider/ProviderContext";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ASSET_SYMBOLS, ASSET_COLORS, AssetIndex } from "@/lib/constants";
import { formatHF, hfColor, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { LiquidatablePosition } from "@/lib/provider/LendingProvider";

export default function LiquidationsPage() {
  const provider = useLendingProvider();
  const { address } = useWallet();
  const [positions, setPositions] = useState<LiquidatablePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LiquidatablePosition | null>(null);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await provider.getLiquidatablePositions();
      setPositions(data);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const executeLiquidation = async (pos: LiquidatablePosition) => {
    if (!address) return toast.error("Connect wallet first");
    setExecuting(true);
    try {
      await provider.liquidate(
        address,
        pos.borrowerAddress,
        pos.debtAsset,
        pos.colAsset,
        pos.maxRepayAmount / 2n,
      );
      toast.success(`Liquidated ${pos.borrowerAddress.slice(0, 8)}...`);
      setSelected(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Liquidation failed");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#f7f8f8]">Liquidations</h1>
        <p className="text-sm text-[#8a8f98] mt-0.5">
          Positions with Health Factor below 1.0 — eligible for liquidation
        </p>
      </div>

      {loading ? (
        <div className="h-32 bg-white/[0.03] border border-white/[0.06] rounded-lg animate-pulse" />
      ) : positions.length === 0 ? (
        <div className="protocol-card p-12 text-center">
          <div className="text-[#10b981] text-4xl mb-3">✓</div>
          <p className="text-[#d0d6e0] font-medium">No liquidatable positions</p>
          <p className="text-[#62666d] text-sm mt-1">All positions have Health Factor ≥ 1.0</p>
        </div>
      ) : (
        <div className="protocol-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.08]">
                {["Borrower", "HF", "Total Debt", "Total Collateral", "Best Debt", "Best Col", "Bonus", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-[#8a8f98] uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(pos => (
                <tr key={pos.borrowerAddress} className="border-b border-white/[0.04] hover:bg-white/[0.025]">
                  <td className="px-4 py-3 font-mono text-xs text-[#d0d6e0]">
                    {pos.borrowerAddress.slice(0, 12)}...
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold tabular-nums" style={{ color: hfColor(pos.healthFactor) }}>
                    {formatHF(pos.healthFactor)}
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums text-[#d0d6e0]">{formatUsd(pos.totalDebtUsd)}</td>
                  <td className="px-4 py-3 text-sm tabular-nums text-[#d0d6e0]">{formatUsd(pos.totalCollateralUsd)}</td>
                  <td className="px-4 py-3">
                    <AssetBadge asset={pos.debtAsset} />
                  </td>
                  <td className="px-4 py-3">
                    <AssetBadge asset={pos.colAsset} />
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums text-[#10b981]">
                    +{formatUsd(pos.estimatedBonus)}
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      onClick={() => setSelected(pos)}
                      className="text-xs bg-[#ef4444]/20 hover:bg-[#ef4444]/30 text-[#ef4444] border border-[#ef4444]/30"
                      variant="outline"
                    >
                      Liquidate
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirmation dialog */}
      <Dialog open={!!selected} onOpenChange={v => !v && setSelected(null)}>
        <DialogContent className="bg-[#0f1011] border border-white/10 text-[#f7f8f8] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#ef4444]">Confirm Liquidation</DialogTitle>
            <DialogDescription className="text-[#8a8f98]">
              You will repay 50% of this position&apos;s debt and receive collateral + bonus.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 mt-2">
              <div className="p-3 bg-white/[0.03] rounded-lg border border-white/[0.06] space-y-2 text-sm">
                <Row label="Borrower" value={selected.borrowerAddress.slice(0, 16) + "..."} mono />
                <Row label="Health Factor" value={formatHF(selected.healthFactor)} color={hfColor(selected.healthFactor)} />
                <Row label="Debt to Repay" value={`~${formatUsd(selected.totalDebtUsd * 0.5)} (50% of ${formatUsd(selected.totalDebtUsd)})`} />
                <Row label="Debt Asset" value={ASSET_SYMBOLS[selected.debtAsset]} />
                <Row label="Collateral Asset" value={ASSET_SYMBOLS[selected.colAsset]} />
                <Row label="Estimated Bonus" value={formatUsd(selected.estimatedBonus)} color="#10b981" />
              </div>
              <Button
                className="w-full bg-[#ef4444] hover:bg-[#dc2626] text-white"
                onClick={() => executeLiquidation(selected)}
                disabled={executing}
              >
                {executing ? "Executing..." : "Confirm Liquidation"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssetBadge({ asset }: { asset: AssetIndex }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
        style={{ background: ASSET_COLORS[asset] }}
      >
        {ASSET_SYMBOLS[asset][0]}
      </div>
      <span className="text-xs text-[#d0d6e0]">{ASSET_SYMBOLS[asset]}</span>
    </div>
  );
}

function Row({ label, value, mono, color }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-[#8a8f98]">{label}</span>
      <span className={`font-medium ${mono ? "font-mono text-xs" : ""}`} style={color ? { color } : {}}>
        {value}
      </span>
    </div>
  );
}
