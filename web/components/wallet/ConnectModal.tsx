"use client";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWallet } from "./WalletProvider";

interface ConnectModalProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectModal({ open, onClose }: ConnectModalProps) {
  const { connect, generateFromFaucet, isLoading } = useWallet();
  const [seedInput, setSeedInput] = useState("");
  const [error, setError] = useState("");

  const handleConnect = () => {
    setError("");
    try {
      connect(seedInput.trim());
      onClose();
      setSeedInput("");
    } catch {
      setError("Invalid seed format. Use a valid XRPL family seed (starts with 's').");
    }
  };

  const handleFaucet = async () => {
    setError("");
    await generateFromFaucet();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-[#0f1011] border border-white/10 text-[#f7f8f8] max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-[#f7f8f8]">Connect Wallet</DialogTitle>
          <DialogDescription className="text-[#8a8f98] text-sm">
            Enter an XRPL seed to connect, or generate a new funded AlphaNet account.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          ⚠ Dev mode only — do not use mainnet keys. Seed stored in session only.
        </div>

        <div className="space-y-3 mt-2">
          <div>
            <label className="text-xs font-medium text-[#8a8f98] uppercase tracking-wide">
              Paste Seed
            </label>
            <Input
              type="password"
              placeholder="sEd... or sn..."
              value={seedInput}
              onChange={e => setSeedInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleConnect()}
              className="mt-1.5 bg-white/[0.02] border-white/10 text-[#f7f8f8] placeholder:text-[#62666d] focus:border-[#5e6ad2]"
            />
            {error && <p className="text-[#ef4444] text-xs mt-1">{error}</p>}
          </div>

          <Button
            onClick={handleConnect}
            disabled={!seedInput.trim()}
            className="w-full bg-[#5e6ad2] hover:bg-[#7170ff] text-[#f7f8f8] font-medium"
          >
            Connect
          </Button>

          <div className="relative flex items-center gap-2">
            <div className="flex-1 border-t border-white/10" />
            <span className="text-xs text-[#62666d]">or</span>
            <div className="flex-1 border-t border-white/10" />
          </div>

          <Button
            variant="outline"
            onClick={handleFaucet}
            disabled={isLoading}
            className="w-full border-white/10 text-[#d0d6e0] hover:bg-white/5 bg-transparent"
          >
            {isLoading ? "Generating..." : "Generate AlphaNet Account (Faucet)"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
