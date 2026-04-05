"use client";
import { useState, useEffect, useCallback } from "react";
import { useLendingProvider } from "../provider/ProviderContext";
import type { Prices } from "../provider/LendingProvider";
import { AssetIndex, WAD } from "../constants";

const DEFAULT_PRICES: Prices = {
  [AssetIndex.XRP]: 2n * WAD,
  [AssetIndex.RLUSD]: WAD,
  [AssetIndex.WBTC]: 60_000n * WAD,
};

export function usePrices(refreshIntervalMs = 5000) {
  const provider = useLendingProvider();
  const [prices, setPrices] = useState<Prices>(DEFAULT_PRICES);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await provider.getPrices();
      setPrices(data);
    } catch {
      // keep previous prices on error
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refresh, refreshIntervalMs]);

  return { prices, loading, refresh };
}
