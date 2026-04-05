"use client";
import { formatHF, hfColor, hfClass } from "@/lib/format";
import { WAD } from "@/lib/constants";

interface Props {
  healthFactor: bigint;
}

export function HealthFactorGauge({ healthFactor }: Props) {
  const isInfinite = healthFactor >= 2n ** 64n;
  const hfNum = isInfinite ? 999 : Number(healthFactor) / Number(WAD);
  const color = hfColor(healthFactor);

  // Fill: clamp to 0–100%, 2.0 = fully green
  const fillPct = isInfinite ? 100 : Math.min((hfNum / 3.0) * 100, 100);

  return (
    <div className="protocol-card p-6">
      <p className="text-xs font-medium text-[#8a8f98] uppercase tracking-widest mb-1">
        Health Factor
      </p>

      <div className="flex items-end gap-3 mb-4">
        <span
          className={`text-3xl font-semibold tabular-nums ${hfClass(healthFactor)}`}
          style={{ color }}
        >
          {formatHF(healthFactor)}
        </span>
        {!isInfinite && (
          <span className="text-sm text-[#8a8f98] mb-1">
            {hfNum >= 2.0 ? "Safe" : hfNum >= 1.2 ? "Caution" : "Liquidatable"}
          </span>
        )}
        {isInfinite && (
          <span className="text-sm text-[#10b981] mb-1">No debt</span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${fillPct}%`, background: color }}
        />
      </div>

      <div className="flex justify-between mt-1">
        <span className="text-xs text-[#62666d]">Liquidation &lt; 1.0</span>
        <span className="text-xs text-[#62666d]">Safe ≥ 2.0</span>
      </div>
    </div>
  );
}
