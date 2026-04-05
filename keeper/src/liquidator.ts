/**
 * Liquidator: executes liquidation transactions against profitable positions.
 *
 * Processes opportunities sequentially (one at a time) to avoid nonce conflicts.
 * Respects a cooldown between submissions to allow ledger confirmation.
 * Supports --dry-run mode that logs without submitting.
 */

import { liquidate, AssetIndex, ASSET_NAMES, WAD } from "xrpl-lending-sdk";
import type { LendingClient, TxResult } from "xrpl-lending-sdk";
import type { ProfitableOpportunity } from "./profitability";
import { ASSET_TOKEN_INFO, XRP_RESERVE_DROPS } from "./config";
import { log } from "./logger";
import { formatWadUsd } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiquidationResult {
  opportunity: ProfitableOpportunity;
  success: boolean;
  txResult?: TxResult;
  error?: string;
  /** Set when the liquidation was intentionally skipped */
  skippedReason?: "dry-run" | "insufficient-balance" | "cooldown";
}

export interface LiquidatorConfig {
  dryRun: boolean;
  cooldownMs: number;
}

// ── Liquidator ────────────────────────────────────────────────────────────────

export class Liquidator {
  private lastExecutionTime = 0;

  constructor(
    private readonly client: LendingClient,
    private readonly config: LiquidatorConfig,
  ) {}

  /**
   * Process a batch of profitable opportunities sequentially.
   * Respects cooldowns between each submission.
   */
  async executeBatch(
    opportunities: ProfitableOpportunity[],
  ): Promise<LiquidationResult[]> {
    const results: LiquidationResult[] = [];

    for (const opp of opportunities) {
      // Enforce cooldown
      const elapsed = Date.now() - this.lastExecutionTime;
      if (elapsed < this.config.cooldownMs && this.lastExecutionTime > 0) {
        const wait = this.config.cooldownMs - elapsed;
        log("INFO", `Cooldown: waiting ${wait}ms before next liquidation`);
        await sleep(wait);
      }

      const result = await this.executeOne(opp);
      results.push(result);

      // Update execution time whether successful or not
      this.lastExecutionTime = Date.now();
    }

    return results;
  }

  /**
   * Attempt to liquidate a single opportunity.
   */
  async executeOne(opp: ProfitableOpportunity): Promise<LiquidationResult> {
    const label = formatOpportunity(opp);

    if (this.config.dryRun) {
      log("INFO", `[DRY-RUN] Would liquidate: ${label}`);
      return { opportunity: opp, success: true, skippedReason: "dry-run" };
    }

    // Balance check
    const hasBalance = await this.hasDebtBalance(opp.debtAsset, opp.maxDebtToRepay);
    if (!hasBalance) {
      log("WARN", `Insufficient balance for ${label}, skipping`, {
        debtAsset: ASSET_NAMES[opp.debtAsset],
        required: opp.maxDebtToRepay.toString(),
      });
      return {
        opportunity: opp,
        success: false,
        skippedReason: "insufficient-balance",
      };
    }

    log("INFO", `Executing liquidation: ${label}`);

    try {
      const txResult = await liquidate(this.client, {
        borrower: opp.borrower,
        debtAsset: opp.debtAsset,
        collateralAsset: opp.collateralAsset,
        debtAmount: opp.maxDebtToRepay,
      });

      const success = txResult.engineResult === "tesSUCCESS";

      if (success) {
        log("INFO", `Liquidation confirmed`, {
          borrower: opp.borrower,
          hash: txResult.hash,
          netProfit: formatWadUsd(opp.netProfitUsd),
          debtAsset: ASSET_NAMES[opp.debtAsset],
          collateralAsset: ASSET_NAMES[opp.collateralAsset],
          debtRepaid: opp.maxDebtToRepay.toString(),
          collateralSeized: opp.collateralToSeize.toString(),
        });
      } else {
        log("WARN", `Liquidation tx failed`, {
          borrower: opp.borrower,
          hash: txResult.hash,
          engineResult: txResult.engineResult,
        });
      }

      return { opportunity: opp, success, txResult };
    } catch (err) {
      const error = String(err);
      log("ERROR", `Liquidation threw exception`, { borrower: opp.borrower, error });
      return { opportunity: opp, success: false, error };
    }
  }

  /**
   * Check whether the keeper wallet has sufficient balance for the debt asset.
   *
   * XRP: account_info → Balance (drops)
   * Tokens: account_lines → find matching trustline
   */
  async hasDebtBalance(
    debtAsset: AssetIndex,
    requiredAmount: bigint,
  ): Promise<boolean> {
    try {
      const account = this.client.getAccountAddress();

      if (debtAsset === AssetIndex.XRP) {
        const resp = await this.client.xrplClient.request({
          command: "account_info",
          account,
        } as Parameters<typeof this.client.xrplClient.request>[0]);

        const data = (resp as unknown as Record<string, unknown>).result as Record<string, unknown>;
        const accountData = data?.account_data as Record<string, unknown>;
        const balanceStr = accountData?.Balance as string;
        if (!balanceStr) return false;

        const balance = BigInt(balanceStr);
        // Keep minimum reserve + required amount
        return balance >= requiredAmount + XRP_RESERVE_DROPS;
      }

      // Token balance check via account_lines
      const tokenInfo = ASSET_TOKEN_INFO[debtAsset];
      if (!tokenInfo) {
        log("WARN", `No token info for asset ${debtAsset}, skipping balance check`);
        return false;
      }

      const resp = await this.client.xrplClient.request({
        command: "account_lines",
        account,
      } as Parameters<typeof this.client.xrplClient.request>[0]);

      const result = (resp as unknown as Record<string, unknown>).result as Record<string, unknown>;
      const lines = (result?.lines as Array<Record<string, unknown>>) ?? [];

      for (const line of lines) {
        if (
          line.currency === tokenInfo.currency &&
          (!tokenInfo.issuer || line.account === tokenInfo.issuer)
        ) {
          // Trustline balance is a string float (e.g., "1000.50")
          // Convert to native units based on asset decimals
          const balanceFloat = parseFloat(line.balance as string);
          if (isNaN(balanceFloat)) continue;

          // Token decimals: RLUSD=6, wBTC=8
          const decimals = debtAsset === AssetIndex.WBTC ? 8 : 6;
          const balanceNative = BigInt(Math.floor(balanceFloat * 10 ** decimals));
          return balanceNative >= requiredAmount;
        }
      }

      return false;
    } catch (err) {
      log("WARN", `Balance check failed`, { error: String(err) });
      return false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatOpportunity(opp: ProfitableOpportunity): string {
  return (
    `borrower=${opp.borrower.slice(0, 12)}… ` +
    `debtAsset=${ASSET_NAMES[opp.debtAsset]} ` +
    `colAsset=${ASSET_NAMES[opp.collateralAsset]} ` +
    `netProfit=${formatWadUsd(opp.netProfitUsd)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
