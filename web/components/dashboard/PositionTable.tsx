"use client";
import { useState } from "react";
import { type UserPositionView } from "@/lib/provider/LendingProvider";
import { type MarketState } from "@/lib/provider/LendingProvider";
import { type Prices } from "@/lib/provider/LendingProvider";
import { ASSET_SYMBOLS, ASSET_COLORS, ASSETS, AssetIndex } from "@/lib/constants";
import { nativeToDisplay, formatUsd, nativeToUsd, bpsToPercent } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { SupplyDialog } from "@/components/actions/SupplyDialog";
import { WithdrawDialog } from "@/components/actions/WithdrawDialog";
import { BorrowDialog } from "@/components/actions/BorrowDialog";
import { RepayDialog } from "@/components/actions/RepayDialog";

interface Props {
  position: UserPositionView;
  markets: MarketState[];
  prices: Prices;
  onRefresh: () => void;
}

type DialogType = "supply" | "withdraw" | "borrow" | "repay" | null;

export function PositionTable({ position, markets, prices, onRefresh }: Props) {
  const [dialog, setDialog] = useState<{ type: DialogType; asset: AssetIndex } | null>(null);

  const supplied = position.positions.filter(p => p.supplyAmount > 0n);
  const borrowed = position.positions.filter(p => p.debtAmount > 0n);
  const collateral = position.positions.filter(p => p.collateral > 0n);

  const openDialog = (type: DialogType, asset: AssetIndex) => setDialog({ type, asset });
  const closeDialog = () => { setDialog(null); onRefresh(); };

  return (
    <div className="space-y-6">
      {/* Supplied */}
      <div>
        <h3 className="text-xs font-semibold text-[#8a8f98] uppercase tracking-widest mb-3">
          Your Supplies
        </h3>
        {supplied.length === 0 ? (
          <EmptyRow message="No supplies yet" />
        ) : (
          <div className="protocol-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <Th>Asset</Th>
                  <Th>Balance</Th>
                  <Th>Value</Th>
                  <Th>APY</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {supplied.map(p => {
                  const m = markets[p.assetIndex];
                  const usd = nativeToUsd(p.supplyAmount, prices[p.assetIndex], p.assetIndex);
                  return (
                    <tr key={p.assetIndex} className="border-b border-white/[0.04] hover:bg-white/[0.025]">
                      <Td><AssetLabel asset={p.assetIndex} /></Td>
                      <Td mono>{nativeToDisplay(p.supplyAmount, p.assetIndex)}</Td>
                      <Td mono>{formatUsd(usd)}</Td>
                      <Td mono className="text-[#10b981]">{bpsToPercent(m?.supplyRateBps ?? 0)}</Td>
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => openDialog("supply", p.assetIndex)}
                            className="text-xs border-white/10 text-[#d0d6e0] hover:bg-white/5 bg-transparent">
                            Supply
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openDialog("withdraw", p.assetIndex)}
                            className="text-xs border-white/10 text-[#d0d6e0] hover:bg-white/5 bg-transparent">
                            Withdraw
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Collateral */}
      <div>
        <h3 className="text-xs font-semibold text-[#8a8f98] uppercase tracking-widest mb-3">
          Collateral
        </h3>
        {collateral.length === 0 ? (
          <EmptyRow message="No collateral deposited" />
        ) : (
          <div className="protocol-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <Th>Asset</Th>
                  <Th>Deposited</Th>
                  <Th>Value</Th>
                  <Th>Liq. Threshold</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {collateral.map(p => {
                  const m = markets[p.assetIndex];
                  const usd = nativeToUsd(p.collateral, prices[p.assetIndex], p.assetIndex);
                  return (
                    <tr key={p.assetIndex} className="border-b border-white/[0.04] hover:bg-white/[0.025]">
                      <Td><AssetLabel asset={p.assetIndex} /></Td>
                      <Td mono>{nativeToDisplay(p.collateral, p.assetIndex)}</Td>
                      <Td mono>{formatUsd(usd)}</Td>
                      <Td mono>{bpsToPercent(m?.liquidationThreshold ?? 0, 0)}</Td>
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => openDialog("borrow", p.assetIndex)}
                            className="text-xs border-white/10 text-[#d0d6e0] hover:bg-white/5 bg-transparent">
                            Borrow
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Borrowed */}
      <div>
        <h3 className="text-xs font-semibold text-[#8a8f98] uppercase tracking-widest mb-3">
          Your Borrows
        </h3>
        {borrowed.length === 0 ? (
          <EmptyRow message="No active borrows" />
        ) : (
          <div className="protocol-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <Th>Asset</Th>
                  <Th>Debt</Th>
                  <Th>Value</Th>
                  <Th>APY</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {borrowed.map(p => {
                  const m = markets[p.assetIndex];
                  const usd = nativeToUsd(p.debtAmount, prices[p.assetIndex], p.assetIndex);
                  return (
                    <tr key={p.assetIndex} className="border-b border-white/[0.04] hover:bg-white/[0.025]">
                      <Td><AssetLabel asset={p.assetIndex} /></Td>
                      <Td mono>{nativeToDisplay(p.debtAmount, p.assetIndex)}</Td>
                      <Td mono>{formatUsd(usd)}</Td>
                      <Td mono className="text-[#f59e0b]">{bpsToPercent(m?.borrowRateBps ?? 0)}</Td>
                      <Td>
                        <Button size="sm" onClick={() => openDialog("repay", p.assetIndex)}
                          className="text-xs bg-[#5e6ad2] hover:bg-[#7170ff] text-white">
                          Repay
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Action dialogs */}
      {dialog?.type === "supply" && (
        <SupplyDialog asset={dialog.asset} open onClose={closeDialog} />
      )}
      {dialog?.type === "withdraw" && (
        <WithdrawDialog asset={dialog.asset} open onClose={closeDialog}
          userShares={position.positions[dialog.asset].supplyShares}
          supplyIndex={markets[dialog.asset]?.supplyIndex ?? BigInt(1e18)} />
      )}
      {dialog?.type === "borrow" && (
        <BorrowDialog asset={dialog.asset} open onClose={closeDialog} />
      )}
      {dialog?.type === "repay" && (
        <RepayDialog asset={dialog.asset} open onClose={closeDialog}
          debtAmount={position.positions[dialog.asset].debtAmount} />
      )}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-xs font-medium text-[#8a8f98] uppercase tracking-wide">
      {children}
    </th>
  );
}

function Td({ children, mono, className }: { children?: React.ReactNode; mono?: boolean; className?: string }) {
  return (
    <td className={`px-4 py-3 text-sm text-[#d0d6e0] ${mono ? "tabular-nums font-mono" : ""} ${className ?? ""}`}>
      {children}
    </td>
  );
}

function AssetLabel({ asset }: { asset: AssetIndex }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
        style={{ background: ASSET_COLORS[asset] }}
      >
        {ASSET_SYMBOLS[asset][0]}
      </div>
      <span className="font-medium text-[#f7f8f8]">{ASSET_SYMBOLS[asset]}</span>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="protocol-card px-4 py-6 text-center text-sm text-[#62666d]">
      {message}
    </div>
  );
}
