/**
 * PositionMonitor: maintains the set of watched accounts and scans them for
 * liquidation opportunities on every price update.
 */

import { findLiquidatablePositions, getUserPosition } from "xrpl-lending-sdk";
import type { LendingClient, LiquidationOpportunity, UserHealthView } from "xrpl-lending-sdk";
import { log } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MonitorConfig {
  /** Initial accounts to watch */
  initialAccounts: string[];
}

// ── PositionMonitor ───────────────────────────────────────────────────────────

export class PositionMonitor {
  private readonly accounts: Set<string>;
  private lastHealthViews: Map<string, UserHealthView> = new Map();

  constructor(
    private readonly client: LendingClient,
    config: MonitorConfig,
  ) {
    this.accounts = new Set(config.initialAccounts);
  }

  /** Add a new account to the watch set (e.g., discovered from tx monitoring). */
  addAccount(account: string): void {
    if (!this.accounts.has(account)) {
      this.accounts.add(account);
      log("INFO", `Monitoring new account`, { account });
    }
  }

  /** Remove an account from the watch set. */
  removeAccount(account: string): void {
    this.accounts.delete(account);
  }

  /** Current watched accounts list. */
  getAccounts(): string[] {
    return [...this.accounts];
  }

  /** Last health views (from previous scan). */
  getLastHealthViews(): Map<string, UserHealthView> {
    return this.lastHealthViews;
  }

  /**
   * Scan all watched accounts for liquidation opportunities.
   *
   * Delegates entirely to the SDK's `findLiquidatablePositions`, which:
   *   - Reads all position state concurrently
   *   - Fetches oracle prices
   *   - Computes health factors
   *   - Finds the best (debtAsset, collateralAsset) pair
   *   - Computes maxDebtToRepay, collateralToSeize, estimatedProfitUsd
   *   - Returns sorted by estimatedProfitUsd descending
   *
   * Returns sorted LiquidationOpportunity[].
   */
  async scan(): Promise<LiquidationOpportunity[]> {
    const accounts = this.getAccounts();
    if (accounts.length === 0) return [];

    log("INFO", `Scanning ${accounts.length} accounts...`);

    const opportunities = await findLiquidatablePositions(this.client, accounts);

    log("INFO", `Scan complete`, {
      scanned: accounts.length,
      liquidatable: opportunities.length,
    });

    return opportunities;
  }

  /**
   * Check a single account's health view (for status queries or transaction-triggered re-checks).
   */
  async checkAccount(account: string): Promise<UserHealthView> {
    const view = await getUserPosition(this.client, account);
    this.lastHealthViews.set(account, view);
    return view;
  }
}
