"use client";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { ProtocolProviderContext } from "@/lib/provider/ProviderContext";
import { getSimulatedProvider } from "@/lib/provider/SimulatedProvider";
import { Topbar } from "@/components/Topbar";
import { TooltipProvider } from "@/components/ui/tooltip";

const provider = getSimulatedProvider();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <ProtocolProviderContext provider={provider}>
        <TooltipProvider>
          <Topbar />
          <main className="flex-1 max-w-[1200px] mx-auto w-full px-6 py-8">
            {children}
          </main>
          <Toaster
            theme="dark"
            toastOptions={{
              style: {
                background: "#0f1011",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#f7f8f8",
              },
            }}
          />
        </TooltipProvider>
      </ProtocolProviderContext>
    </WalletProvider>
  );
}
