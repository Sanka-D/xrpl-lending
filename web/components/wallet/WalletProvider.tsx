"use client";
/**
 * WalletProvider — local seed signer for AlphaNet / simulated use.
 * Seed stored in sessionStorage only (never localStorage).
 * "Dev mode only — do not use mainnet keys."
 */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { Wallet } from "xrpl";

interface WalletState {
  seed: string | null;
  address: string | null;
  isConnected: boolean;
  isLoading: boolean;
  connect: (seed: string) => void;
  generateFromFaucet: () => Promise<void>;
  disconnect: () => void;
  sign: (txJson: Record<string, unknown>) => { tx_blob: string; hash: string } | null;
}

const WalletCtx = createContext<WalletState | null>(null);

const SESSION_KEY = "xrpl_lending_seed";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [seed, setSeed] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Restore from sessionStorage on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        const wallet = Wallet.fromSeed(stored);
        setSeed(stored);
        setAddress(wallet.address);
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
  }, []);

  const connect = useCallback((rawSeed: string) => {
    const wallet = Wallet.fromSeed(rawSeed.trim());
    setSeed(rawSeed.trim());
    setAddress(wallet.address);
    sessionStorage.setItem(SESSION_KEY, rawSeed.trim());
  }, []);

  const generateFromFaucet = useCallback(async () => {
    setIsLoading(true);
    try {
      // Use XRPL testnet faucet (AlphaNet-compatible seed format)
      const res = await fetch("https://faucet.altnet.rippletest.net/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination: "" }),
      });
      const data = await res.json() as { account?: { seed?: string; classicAddress?: string } };
      const faucetSeed = data?.account?.seed;
      if (!faucetSeed) throw new Error("No seed in faucet response");
      connect(faucetSeed);
    } catch {
      // Fallback: generate a local wallet (not funded)
      const wallet = Wallet.generate();
      connect(wallet.seed!);
    } finally {
      setIsLoading(false);
    }
  }, [connect]);

  const disconnect = useCallback(() => {
    setSeed(null);
    setAddress(null);
    sessionStorage.removeItem(SESSION_KEY);
  }, []);

  const sign = useCallback(
    (txJson: Record<string, unknown>) => {
      if (!seed) return null;
      try {
        const wallet = Wallet.fromSeed(seed);
        return wallet.sign(txJson as Parameters<typeof wallet.sign>[0]);
      } catch {
        return null;
      }
    },
    [seed],
  );

  return (
    <WalletCtx.Provider
      value={{ seed, address, isConnected: !!address, isLoading, connect, generateFromFaucet, disconnect, sign }}
    >
      {children}
    </WalletCtx.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be inside WalletProvider");
  return ctx;
}
