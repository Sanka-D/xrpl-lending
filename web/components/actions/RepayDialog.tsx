"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useLendingProvider } from "@/lib/provider/ProviderContext";
import { useWallet } from "@/components/wallet/WalletProvider";
import { AssetIndex, ASSET_SYMBOLS } from "@/lib/constants";
import { parseTokenInput, nativeToDisplay } from "@/lib/format";

interface Props {
  asset: AssetIndex;
  open: boolean;
  onClose: () => void;
  debtAmount: bigint;
}

export function RepayDialog({ asset, open, onClose, debtAmount }: Props) {
  const { address } = useWallet();
  const provider = useLendingProvider();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const maxDisplay = nativeToDisplay(debtAmount, asset);

  const handleRepay = async () => {
    if (!address) return;
    setLoading(true);
    try {
      const native = parseTokenInput(amount, asset);
      if (native === 0n) throw new Error("Enter a valid amount");
      await provider.repay(address, asset, native);
      toast.success(`Repaid ${amount} ${ASSET_SYMBOLS[asset]}`);
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
          <DialogTitle>Repay {ASSET_SYMBOLS[asset]}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <div className="flex justify-between text-xs text-[#8a8f98] mb-1">
              <span>Amount</span>
              <button className="text-[#5e6ad2] hover:text-[#7170ff]" onClick={() => setAmount(maxDisplay)}>
                Max: {maxDisplay} {ASSET_SYMBOLS[asset]}
              </button>
            </div>
            <Input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="bg-white/[0.02] border-white/10 text-[#f7f8f8] placeholder:text-[#62666d] tabular-nums"
            />
          </div>
          <Button
            className="w-full bg-[#5e6ad2] hover:bg-[#7170ff] text-white"
            onClick={handleRepay}
            disabled={loading || !amount || !address}
          >
            {loading ? "Repaying..." : `Repay ${ASSET_SYMBOLS[asset]}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
