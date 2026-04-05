"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { ILendingProvider } from "./LendingProvider";

const ProviderCtx = createContext<ILendingProvider | null>(null);

export function ProtocolProviderContext({
  provider,
  children,
}: {
  provider: ILendingProvider;
  children: ReactNode;
}) {
  return <ProviderCtx.Provider value={provider}>{children}</ProviderCtx.Provider>;
}

export function useLendingProvider(): ILendingProvider {
  const ctx = useContext(ProviderCtx);
  if (!ctx) throw new Error("useLendingProvider must be inside ProtocolProviderContext");
  return ctx;
}
