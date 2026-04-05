"use client";
import { SimulatedLedger } from "../SimulatedLedger";
import { AssetIndex, V1_MARKETS, WAD, BPS, ASSET_DECIMALS, ASSETS } from "../constants";
import type {
  ILendingProvider, MarketState, UserPositionView, UserAssetPosition,
  Prices, LiquidatablePosition, TxResult,
} from "./LendingProvider";

function freshTx(): TxResult {
  return {
    hash: "SIM_" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    validated: true,
    engineResult: "tesSUCCESS",
  };
}

export class SimulatedProvider implements ILendingProvider {
  private ledger: SimulatedLedger;
  private trackedAddresses: Set<string> = new Set();

  constructor(ledger?: SimulatedLedger) {
    this.ledger = ledger ?? new SimulatedLedger();
    this.seedDemoState();
  }

  private seedDemoState(): void {
    // Use addresses from the E2E tests (verified valid XRPL addresses)
    const alice   = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"; // genesis
    const bob     = "rGjF46jKSsSmVXxXhNYHLUxm58WaA9cEfq";
    const charlie = "rJbHpj6YMd9SdqF2DHn3S7vVdvvmTjeico";

    // Alice — RLUSD + XRP supplier
    this.ledger.supply(alice, AssetIndex.RLUSD, 100_000n * 1_000_000n);
    this.ledger.supply(alice, AssetIndex.XRP, 50_000n * 1_000_000n);
    this.trackedAddresses.add(alice);

    // Bob — XRP collateral, RLUSD borrower
    this.ledger.depositCollateral(bob, AssetIndex.XRP, 10_000n * 1_000_000n);
    this.ledger.borrow(bob, AssetIndex.RLUSD, 8_000n * 1_000_000n);
    this.trackedAddresses.add(bob);

    // Charlie — wBTC collateral, XRP borrower
    this.ledger.depositCollateral(charlie, AssetIndex.WBTC, 1n * 100_000_000n);
    this.ledger.borrow(charlie, AssetIndex.XRP, 20_000n * 1_000_000n);
    this.trackedAddresses.add(charlie);
  }

  getLedger(): SimulatedLedger { return this.ledger; }
  trackAddress(address: string): void { this.trackedAddresses.add(address); }

  async getMarkets(): Promise<MarketState[]> {
    return ASSETS.map(idx => {
      const s = this.ledger.getInterestState(idx);
      const cfg = V1_MARKETS[idx];
      return {
        assetIndex: idx,
        totalSupply: s.totalSupply,
        totalBorrows: s.totalBorrows,
        supplyRateBps: Number(s.supplyRateBps),
        borrowRateBps: Number(s.borrowRateBps),
        borrowIndex: s.borrowIndex,
        supplyIndex: s.supplyIndex,
        ltv: cfg.ltv,
        liquidationThreshold: cfg.liquidationThreshold,
        liquidationBonus: cfg.liquidationBonus,
        reserveFactor: cfg.reserveFactor,
        optimalUtilization: cfg.optimalUtilization,
      };
    });
  }

  async getPrices(): Promise<Prices> {
    const raw = this.ledger.getPrices();
    return {
      [AssetIndex.XRP]: raw[0],
      [AssetIndex.RLUSD]: raw[1],
      [AssetIndex.WBTC]: raw[2],
    };
  }

  async getPosition(address: string): Promise<UserPositionView> {
    this.trackAddress(address);
    const prices = await this.getPrices();
    const markets = await this.getMarkets();

    const positions: UserAssetPosition[] = [];
    let totalCollateralUsd = 0;
    let totalDebtUsd = 0;
    let totalWeightedColWad = 0n;
    let totalDebtUsdWad = 0n;
    let supplyTotalUsd = 0;

    for (const idx of ASSETS) {
      const market = markets[idx];
      const dec = ASSET_DECIMALS[idx];
      const divisor = 10n ** BigInt(dec);
      const price = prices[idx];
      const cfg = V1_MARKETS[idx];

      const supplyShares = this.ledger.getUserShares(address, idx);
      const collateral = this.ledger.getUserCollateral(address, idx);
      const debtPrincipal = this.ledger.getUserDebtPrincipal(address, idx);
      const userBorrowIndex = this.ledger.getUserBorrowIndex(address, idx);

      const supplyAmount = supplyShares === 0n ? 0n
        : (supplyShares * market.supplyIndex + WAD / 2n) / WAD;

      const debtAmount = debtPrincipal === 0n ? 0n
        : debtPrincipal * market.borrowIndex / userBorrowIndex;

      positions.push({ assetIndex: idx, supplyShares, supplyAmount, collateral, debtPrincipal, debtAmount });

      const colUsd = Number(collateral * price / divisor / WAD);
      const debtUsd = Number(debtAmount * price / divisor / WAD);
      const supplyUsd = Number(supplyAmount * price / divisor / WAD);

      totalCollateralUsd += colUsd;
      totalDebtUsd += debtUsd;
      supplyTotalUsd += supplyUsd;

      if (collateral > 0n) {
        totalWeightedColWad += collateral * price / divisor * BigInt(cfg.liquidationThreshold) / BPS;
      }
      if (debtAmount > 0n) {
        totalDebtUsdWad += debtAmount * price / divisor;
      }
    }

    const healthFactor = totalDebtUsdWad === 0n ? 2n ** 128n - 1n
      : (totalWeightedColWad * WAD) / totalDebtUsdWad;

    let ltWeightedColWad = 0n;
    for (const idx of ASSETS) {
      const cfg = V1_MARKETS[idx];
      const pos = positions[idx];
      const dec = ASSET_DECIMALS[idx];
      const divisor = 10n ** BigInt(dec);
      const price = prices[idx];
      if (pos.collateral > 0n) {
        ltWeightedColWad += pos.collateral * price / divisor * BigInt(cfg.ltv) / BPS;
      }
    }
    const borrowCapacityWad = ltWeightedColWad > totalDebtUsdWad
      ? ltWeightedColWad - totalDebtUsdWad : 0n;

    return {
      address,
      positions,
      healthFactor,
      totalCollateralUsd,
      totalDebtUsd,
      netWorthUsd: supplyTotalUsd + totalCollateralUsd - totalDebtUsd,
      borrowCapacityUsd: Number(borrowCapacityWad) / Number(WAD),
    };
  }

  async getLiquidatablePositions(): Promise<LiquidatablePosition[]> {
    const prices = await this.getPrices();
    const result: LiquidatablePosition[] = [];

    for (const addr of this.trackedAddresses) {
      const pos = await this.getPosition(addr);
      if (pos.healthFactor < WAD && pos.totalDebtUsd > 0) {
        let bestDebtAsset = AssetIndex.XRP;
        let bestColAsset = AssetIndex.RLUSD;
        let maxDebt = 0n;
        let maxCol = 0n;
        for (const idx of ASSETS) {
          if (pos.positions[idx].debtAmount > maxDebt) {
            maxDebt = pos.positions[idx].debtAmount; bestDebtAsset = idx;
          }
          if (pos.positions[idx].collateral > maxCol) {
            maxCol = pos.positions[idx].collateral; bestColAsset = idx;
          }
        }
        const maxRepay = maxDebt / 2n;
        const price = prices[bestColAsset];
        const dec = ASSET_DECIMALS[bestColAsset];
        const bonus = V1_MARKETS[bestColAsset].liquidationBonus;
        const estimatedBonusUsd = Number(maxRepay * price / (10n ** BigInt(dec)) / WAD) * (bonus / 10_000);
        result.push({
          borrowerAddress: addr, healthFactor: pos.healthFactor,
          totalDebtUsd: pos.totalDebtUsd, totalCollateralUsd: pos.totalCollateralUsd,
          debtAsset: bestDebtAsset, colAsset: bestColAsset,
          maxRepayAmount: maxRepay, estimatedBonus: estimatedBonusUsd,
        });
      }
    }
    return result;
  }

  async supply(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult> {
    this.ledger.supply(address, asset, amount); return freshTx();
  }
  async withdraw(address: string, asset: AssetIndex, shares: bigint): Promise<TxResult> {
    this.ledger.withdraw(address, asset, shares); return freshTx();
  }
  async depositCollateral(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult> {
    this.ledger.depositCollateral(address, asset, amount); return freshTx();
  }
  async withdrawCollateral(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult> {
    this.ledger.withdrawCollateral(address, asset, amount); return freshTx();
  }
  async borrow(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult> {
    this.ledger.borrow(address, asset, amount); return freshTx();
  }
  async repay(address: string, asset: AssetIndex, amount: bigint): Promise<TxResult> {
    this.ledger.repay(address, asset, amount); return freshTx();
  }
  async liquidate(
    liquidatorAddress: string, borrowerAddress: string,
    debtAsset: AssetIndex, colAsset: AssetIndex, amount: bigint,
  ): Promise<TxResult> {
    this.ledger.liquidate(liquidatorAddress, borrowerAddress, debtAsset, colAsset, amount);
    return freshTx();
  }

  setPrice(asset: AssetIndex, priceWad: bigint): void { this.ledger.setOraclePrice(asset, priceWad); }
  advanceTime(seconds: bigint): void { this.ledger.advanceTime(seconds); }
}

let _instance: SimulatedProvider | null = null;
export function getSimulatedProvider(): SimulatedProvider {
  if (!_instance) _instance = new SimulatedProvider();
  return _instance;
}
