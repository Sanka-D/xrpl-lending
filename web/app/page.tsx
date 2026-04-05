"use client";
import { useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { usePosition } from "@/lib/hooks/usePosition";
import { useMarkets } from "@/lib/hooks/useMarkets";
import { usePrices } from "@/lib/hooks/usePrices";
import { NetWorthCard } from "@/components/dashboard/NetWorthCard";
import { HealthFactorGauge } from "@/components/dashboard/HealthFactorGauge";
import { PositionTable } from "@/components/dashboard/PositionTable";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  const { address } = useWallet();
  const { position, loading: posLoading, refresh } = usePosition(address);
  const { markets } = useMarkets();
  const { prices } = usePrices();
  const [connectOpen, setConnectOpen] = useState(false);

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#5e6ad2]/20 border border-[#5e6ad2]/30 flex items-center justify-center">
          <div className="w-8 h-8 rounded-lg bg-[#5e6ad2] flex items-center justify-center">
            <span className="text-white text-sm font-bold">XL</span>
          </div>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-[#f7f8f8] mb-2">XRPL Lending Protocol</h1>
          <p className="text-[#8a8f98] text-sm max-w-md">
            Permissionless lending on XRPL. Supply assets to earn yield, or deposit collateral to borrow.
          </p>
        </div>
        <Button
          onClick={() => setConnectOpen(true)}
          className="bg-[#5e6ad2] hover:bg-[#7170ff] text-white px-6"
        >
          Connect Wallet
        </Button>
        <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      </div>
    );
  }

  if (posLoading || !position) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#f7f8f8]">Dashboard</h1>
        <p className="text-sm text-[#8a8f98] mt-0.5">Your position overview</p>
      </div>

      {/* Top metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NetWorthCard position={position} />
        <HealthFactorGauge healthFactor={position.healthFactor} />
      </div>

      {/* Position tables */}
      <PositionTable
        position={position}
        markets={markets}
        prices={prices}
        onRefresh={refresh}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-6 w-32 bg-white/[0.06] rounded" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-36 bg-white/[0.03] border border-white/[0.06] rounded-lg" />
        <div className="h-36 bg-white/[0.03] border border-white/[0.06] rounded-lg" />
      </div>
      <div className="h-48 bg-white/[0.03] border border-white/[0.06] rounded-lg" />
    </div>
  );
}
