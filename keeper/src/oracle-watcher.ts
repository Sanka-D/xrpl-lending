/**
 * OracleWatcher: subscribes to XRPL ledger close events, fetches DIA oracle
 * prices on each ledger, and notifies the rest of the pipeline via callback.
 */

import { EventEmitter } from "node:events";
import {
  getAllPrices,
  LendingError,
  LendingErrorCode,
} from "xrpl-lending-sdk";
import type { LendingClient, OraclePrice } from "xrpl-lending-sdk";
import { log } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PriceUpdate {
  /** Full OraclePrice objects, one per asset */
  prices: OraclePrice[];
  /** Convenience bigint[] indexed by AssetIndex for math functions */
  pricesByIndex: bigint[];
  /** Oracle LastUpdateTime (UNIX seconds) */
  lastUpdateTime: number;
  /** XRPL ledger index that triggered this update */
  ledgerIndex: number;
}

export type PriceCallback = (update: PriceUpdate) => Promise<void> | void;

// ── OracleWatcher ─────────────────────────────────────────────────────────────

export class OracleWatcher extends EventEmitter {
  private currentPrices: OraclePrice[] | null = null;
  private running = false;
  private ledgerListener: ((ledger: Record<string, unknown>) => void) | null = null;

  constructor(
    private readonly client: LendingClient,
    private readonly onPriceUpdate: PriceCallback,
  ) {
    super();
  }

  /** Current cached prices, or null if never successfully fetched. */
  getCurrentPrices(): OraclePrice[] | null {
    return this.currentPrices;
  }

  /** Prices as a bigint[] indexed by AssetIndex. Null if never fetched. */
  getPriceArray(): bigint[] | null {
    if (!this.currentPrices) return null;
    const arr = new Array<bigint>(3).fill(0n);
    for (const p of this.currentPrices) arr[p.assetIndex] = p.priceWad;
    return arr;
  }

  /**
   * Subscribe to the XRPL ledger stream and start fetching prices.
   * Immediately fetches prices once on startup.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Subscribe to ledger stream
    await this.client.xrplClient.request({
      command: "subscribe",
      streams: ["ledger"],
    } as Parameters<typeof this.client.xrplClient.request>[0]);

    // Register ledger close listener
    this.ledgerListener = (ledger: Record<string, unknown>) => {
      const ledgerIndex = (ledger.ledger_index as number) ?? 0;
      void this.fetchPrices(ledgerIndex);
    };
    this.client.xrplClient.on("ledgerClosed", this.ledgerListener);

    this.running = true;
    log("INFO", "OracleWatcher started, subscribed to ledger stream");

    // Fetch immediately on startup (don't wait for first ledger close)
    await this.fetchPrices(0);
  }

  /** Unsubscribe from the ledger stream and stop. */
  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.ledgerListener) {
      this.client.xrplClient.off("ledgerClosed", this.ledgerListener);
      this.ledgerListener = null;
    }

    try {
      await this.client.xrplClient.request({
        command: "unsubscribe",
        streams: ["ledger"],
      } as Parameters<typeof this.client.xrplClient.request>[0]);
    } catch {
      // Ignore unsubscribe errors during shutdown
    }

    this.running = false;
    log("INFO", "OracleWatcher stopped");
  }

  /**
   * Fetch current oracle prices. Called on each ledger close and at startup.
   * Returns the PriceUpdate on success, or null on stale/error.
   */
  async fetchPrices(ledgerIndex: number): Promise<PriceUpdate | null> {
    try {
      const prices = await getAllPrices(this.client);
      this.currentPrices = prices;

      const pricesByIndex = new Array<bigint>(3).fill(0n);
      for (const p of prices) pricesByIndex[p.assetIndex] = p.priceWad;

      const update: PriceUpdate = {
        prices,
        pricesByIndex,
        lastUpdateTime: prices[0]?.lastUpdateTime ?? 0,
        ledgerIndex,
      };

      this.emit("prices", update);
      await this.onPriceUpdate(update);
      return update;
    } catch (err) {
      if (err instanceof LendingError) {
        if (err.code === LendingErrorCode.OracleStale) {
          log("WARN", "Oracle prices are stale — skipping this ledger", { ledgerIndex });
          this.emit("stale", { ledgerIndex });
          return null;
        }
        if (err.code === LendingErrorCode.OracleCircuitBreaker) {
          log("ERROR", "RLUSD circuit breaker triggered — price outside [0.95, 1.05]", {
            ledgerIndex,
          });
          this.emit("circuitBreaker", { ledgerIndex });
          return null;
        }
      }
      log("ERROR", "Failed to fetch oracle prices", {
        ledgerIndex,
        error: String(err),
      });
      this.emit("error", err);
      return null;
    }
  }
}
