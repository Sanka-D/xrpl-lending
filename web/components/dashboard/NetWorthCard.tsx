"use client";
import type { UserPositionView } from "@/lib/provider/LendingProvider";
import { formatUsd } from "@/lib/format";

export function NetWorthCard({ position }: { position: UserPositionView }) {
  return (
    <div className="protocol-card p-6">
      <p className="text-xs font-medium text-[#8a8f98] uppercase tracking-widest mb-1">Net Worth</p>
      <p className="text-3xl font-semibold text-[#f7f8f8] tabular-nums">
        {formatUsd(position.netWorthUsd)}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-[#8a8f98] mb-0.5">Collateral</p>
          <p className="text-base font-medium tabular-nums">{formatUsd(position.totalCollateralUsd)}</p>
        </div>
        <div>
          <p className="text-xs text-[#8a8f98] mb-0.5">Debt</p>
          <p className="text-base font-medium tabular-nums text-[#ef4444]">
            {formatUsd(position.totalDebtUsd)}
          </p>
        </div>
        <div>
          <p className="text-xs text-[#8a8f98] mb-0.5">Borrow Capacity Left</p>
          <p className="text-base font-medium tabular-nums text-[#10b981]">
            {formatUsd(position.borrowCapacityUsd)}
          </p>
        </div>
      </div>
    </div>
  );
}
