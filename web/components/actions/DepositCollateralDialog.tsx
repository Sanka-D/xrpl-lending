"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useLendingProvider } from "@/lib/provider/ProviderContext";
import { useWallet } from "@/components/wallet/WalletProvider";
import { AssetIndex, ASSET_SYMBOLS } from "@/lib/constants";
import { parseTokenInput } from "@/lib/format";

interface Props {
  asset: AssetIndex;
  open: boolean;
  onClose: () => void;
}

export function DepositCollateralDialog({ asset, open, onClose }: Props) {
  const { address } = useWallet();
  const provider = useLendingProvider();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const handleDeposit = async () => {
    if (!address) return;
    setLoading(true);
    try {
      const native = parseTokenInput(amount, asset);
      if (native === 0n) throw new Error("Enter a valid amount");
      await provider.depositCollateral(address, asset, native);
      toast.success(`Deposited ${amount} ${ASSET_SYMBOLS[asset]} as collateral`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-[#0f1011] border border-white/10 text-[#f7f8f8] max-w-sm">
        <DialogHeader>
          <DialogTitle>Deposit Collateral — {ASSET_SYMBOLS[asset]}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <Input
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="bg-white/[0.02] border-white/10 text-[#f7f8f8] placeholder:text-[#62666d] tabular-nums"
          />
          <Button
            className="w-full bg-[#5e6ad2] hover:bg-[#7170ff] text-white"
            onClick={handleDeposit}
            disabled={loading || !amount || !address}
          >
            {loading ? "Depositing..." : `Deposit as Collateral`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
