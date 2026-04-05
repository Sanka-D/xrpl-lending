"use client";
import { useState, useEffect, useCallback } from "react";
import { useLendingProvider } from "../provider/ProviderContext";
import type { UserPositionView } from "../provider/LendingProvider";

export function usePosition(address: string | null, refreshIntervalMs = 5000) {
  const provider = useLendingProvider();
  const [position, setPosition] = useState<UserPositionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) {
      setPosition(null);
      return;
    }
    setLoading(true);
    try {
      const data = await provider.getPosition(address);
      setPosition(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load position");
    } finally {
      setLoading(false);
    }
  }, [provider, address]);

  useEffect(() => {
    refresh();
    if (!address) return;
    const id = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refresh, refreshIntervalMs, address]);

  return { position, loading, error, refresh };
}
