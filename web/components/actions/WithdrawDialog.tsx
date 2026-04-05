"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useLendingProvider } from "@/lib/provider/ProviderContext";
import { useWallet } from "@/components/wallet/WalletProvider";
import { AssetIndex, ASSET_SYMBOLS, ASSET_DECIMALS, WAD } from "@/lib/constants";
import { parseTokenInput, nativeToDisplay } from "@/lib/format";

interface Props {
  asset: AssetIndex;
  open: boolean;
  onClose: () => void;
  userShares: bigint;
  supplyIndex: bigint;
}

export function WithdrawDialog({ asset, open, onClose, userShares, supplyIndex }: Props) {
  const { address } = useWallet();
  const provider = useLendingProvider();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  // Max withdraw in underlying tokens
  const maxUnderlying = (userShares * supplyIndex + WAD / 2n) / WAD;
  const maxDisplay = nativeToDisplay(maxUnderlying, asset);

  const handleWithdraw = async () => {
    if (!address) return;
    setLoading(true);
    try {
      // Convert token amount → shares
      const underlyingRequested = parseTokenInput(amount, asset);
      if (underlyingRequested === 0n) throw new Error("Enter a valid amount");
      // shares = underlying * WAD / supplyIndex
      const shares = (underlyingRequested * WAD + supplyIndex / 2n) / supplyIndex;
      const actualShares = shares > userShares ? userShares : shares;
      await provider.withdraw(address, asset, actualShares);
      toast.success(`Withdrew ${amount} ${ASSET_SYMBOLS[asset]}`);
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
          <DialogTitle>Withdraw {ASSET_SYMBOLS[asset]}</DialogTitle>
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
            onClick={handleWithdraw}
            disabled={loading || !amount || !address}
          >
            {loading ? "Withdrawing..." : `Withdraw ${ASSET_SYMBOLS[asset]}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
