"use client";
/**
 * Hidden admin panel at /admin — lets you adjust simulated oracle prices
 * to test liquidation scenarios without a real XRPL connection.
 * Not linked from the main nav.
 */
import { useState } from "react";
import { useLendingProvider } from "@/lib/provider/ProviderContext";
import { SimulatedProvider } from "@/lib/provider/SimulatedProvider";
import { ASSET_SYMBOLS, ASSETS, WAD } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export default function AdminPage() {
  const provider = useLendingProvider();
  const sim = provider instanceof SimulatedProvider ? provider : null;
  const [prices, setPrices] = useState({ 0: "2", 1: "1", 2: "60000" });
  const [time, setTime] = useState("86400");

  if (!sim) {
    return <p className="text-[#8a8f98] p-8">Admin panel only available in Simulated mode.</p>;
  }

  const applyPrices = () => {
    ASSETS.forEach(idx => {
      const raw = parseFloat(prices[idx as keyof typeof prices] || "0");
      if (!isNaN(raw) && raw > 0) {
        sim.setPrice(idx, BigInt(Math.round(raw * 1e10)) * 100_000_000n);
      }
    });
    toast.success("Prices updated in simulator");
  };

  const advanceTime = () => {
    const secs = BigInt(parseInt(time) || 86400);
    sim.advanceTime(secs);
    toast.success(`Advanced time by ${secs} seconds`);
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h1 className="text-xl font-semibold text-[#f7f8f8]">Admin — Simulated Ledger</h1>
        <p className="text-sm text-[#8a8f98] mt-0.5">
          Adjust oracle prices and time to test scenarios (e.g. trigger liquidations).
        </p>
      </div>

      <div className="protocol-card p-5 space-y-4">
        <h2 className="text-sm font-medium text-[#d0d6e0]">Oracle Prices (USD)</h2>
        {ASSETS.map(idx => (
          <div key={idx} className="flex items-center gap-3">
            <label className="w-16 text-sm text-[#8a8f98]">{ASSET_SYMBOLS[idx]}</label>
            <Input
              type="number"
              value={prices[idx as keyof typeof prices]}
              onChange={e => setPrices(p => ({ ...p, [idx]: e.target.value }))}
              className="bg-white/[0.02] border-white/10 text-[#f7f8f8] w-32 tabular-nums"
            />
            <span className="text-xs text-[#62666d]">USD</span>
          </div>
        ))}
        <Button onClick={applyPrices} className="bg-[#5e6ad2] hover:bg-[#7170ff] text-white">
          Apply Prices
        </Button>
      </div>

      <div className="protocol-card p-5 space-y-4">
        <h2 className="text-sm font-medium text-[#d0d6e0]">Advance Time</h2>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            value={time}
            onChange={e => setTime(e.target.value)}
            className="bg-white/[0.02] border-white/10 text-[#f7f8f8] w-32 tabular-nums"
          />
          <span className="text-xs text-[#62666d]">seconds</span>
        </div>
        <p className="text-xs text-[#8a8f98]">
          86400s = 1 day, 604800s = 1 week. Advances interest accrual.
        </p>
        <Button variant="outline" onClick={advanceTime}
          className="border-white/10 text-[#d0d6e0] hover:bg-white/5 bg-transparent">
          Advance Time
        </Button>
      </div>
    </div>
  );
}
