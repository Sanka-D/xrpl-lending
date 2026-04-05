"use client";
import { useState, useEffect, useCallback } from "react";
import { useLendingProvider } from "../provider/ProviderContext";
import type { MarketState } from "../provider/LendingProvider";

export function useMarkets(refreshIntervalMs = 5000) {
  const provider = useLendingProvider();
  const [markets, setMarkets] = useState<MarketState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await provider.getMarkets();
      setMarkets(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load markets");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refresh, refreshIntervalMs]);

  return { markets, loading, error, refresh };
}
