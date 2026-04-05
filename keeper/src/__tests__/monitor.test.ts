import { describe, it, expect, vi } from "vitest";
import { PositionMonitor } from "../monitor";
import { WAD, AssetIndex } from "xrpl-lending-sdk";
import type { LendingClient, LiquidationOpportunity } from "xrpl-lending-sdk";

function createMockClient(): LendingClient {
  return {
    xrplClient: {} as unknown,
    contractAddress: "rContract",
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    setWallet: vi.fn(),
    getWallet: vi.fn(),
    getAccountAddress: vi.fn(() => "rKeeper"),
    buildInvokeTx: vi.fn(),
    submitInvoke: vi.fn(),
    readContractState: vi.fn(async () => null),
    readOracleLedgerEntry: vi.fn(),
  } as unknown as LendingClient;
}

function makeOpportunity(borrower: string, profit: bigint): LiquidationOpportunity {
  return {
    borrower,
    healthFactor: WAD / 2n,
    debtAsset: AssetIndex.RLUSD,
    collateralAsset: AssetIndex.WBTC,
    maxDebtToRepay: 1_000_000_000n,
    collateralToSeize: 100_000n,
    estimatedProfitUsd: profit,
  };
}

// ── Account management ────────────────────────────────────────────────────────

describe("PositionMonitor account management", () => {
  it("initializes with provided accounts", () => {
    const client = createMockClient();
    const monitor = new PositionMonitor(client, {
      initialAccounts: ["rAlice", "rBob"],
    });
    expect(monitor.getAccounts()).toContain("rAlice");
    expect(monitor.getAccounts()).toContain("rBob");
    expect(monitor.getAccounts()).toHaveLength(2);
  });

  it("addAccount adds a new account", () => {
    const client = createMockClient();
    const monitor = new PositionMonitor(client, { initialAccounts: [] });
    monitor.addAccount("rAlice");
    expect(monitor.getAccounts()).toContain("rAlice");
  });

  it("addAccount deduplicates", () => {
    const client = createMockClient();
    const monitor = new PositionMonitor(client, { initialAccounts: ["rAlice"] });
    monitor.addAccount("rAlice");
    expect(monitor.getAccounts()).toHaveLength(1);
  });

  it("removeAccount removes account", () => {
    const client = createMockClient();
    const monitor = new PositionMonitor(client, { initialAccounts: ["rAlice", "rBob"] });
    monitor.removeAccount("rAlice");
    expect(monitor.getAccounts()).not.toContain("rAlice");
    expect(monitor.getAccounts()).toHaveLength(1);
  });
});

// ── scan ─────────────────────────────────────────────────────────────────────

describe("PositionMonitor.scan", () => {
  it("returns empty array when no accounts", async () => {
    const client = createMockClient();
    const monitor = new PositionMonitor(client, { initialAccounts: [] });
    const result = await monitor.scan();
    expect(result).toEqual([]);
  });

  it("delegates to SDK findLiquidatablePositions", async () => {
    // We can't easily mock the SDK module import, but we can verify the contract:
    // scan() should call readContractState (which findLiquidatablePositions uses)
    const readContractState = vi.fn(async () => null);
    const readOracleLedgerEntry = vi.fn(async () => ({
      LedgerEntryType: "Oracle",
      LastUpdateTime: Math.floor(Date.now() / 1000),
      PriceDataSeries: [
        { PriceData: { BaseAsset: "XRP", QuoteAsset: "USD", AssetPrice: "200000000", Scale: -8 } },
        { PriceData: { BaseAsset: "RLUSD", QuoteAsset: "USD", AssetPrice: "100000000", Scale: -8 } },
        { PriceData: { BaseAsset: "BTC", QuoteAsset: "USD", AssetPrice: "6000000000000", Scale: -8 } },
      ],
    }));

    const client = {
      ...createMockClient(),
      readContractState,
      readOracleLedgerEntry,
    } as unknown as LendingClient;

    const monitor = new PositionMonitor(client, { initialAccounts: ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"] });
    const result = await monitor.scan();

    // No position state → all balances 0 → no debt → HF = MAX → not liquidatable
    expect(result).toEqual([]);
    // Verify the SDK was actually invoked (readContractState is called internally)
    expect(readContractState).toHaveBeenCalled();
  });
});
