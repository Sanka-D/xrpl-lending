import { describe, it, expect, vi, beforeEach } from "vitest";
import { Liquidator } from "../liquidator";
import { WAD, AssetIndex } from "xrpl-lending-sdk";
import type { LendingClient, TxResult } from "xrpl-lending-sdk";
import type { ProfitableOpportunity } from "../profitability";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const DEFAULT_TX_RESULT: TxResult = {
  hash: "AABB1122",
  validated: true,
  engineResult: "tesSUCCESS",
};

function createMockClient(overrides: {
  accountBalance?: bigint;
  txResult?: TxResult;
  submitInvoke?: LendingClient["submitInvoke"];
} = {}): LendingClient {
  const { accountBalance = 100_000_000n, txResult = DEFAULT_TX_RESULT } = overrides;

  const mockAccountInfoResponse = {
    result: {
      account_data: {
        Balance: accountBalance.toString(),
      },
    },
  };

  return {
    xrplClient: {
      request: vi.fn(async (req: Record<string, unknown>) => {
        if (req.command === "account_info") return mockAccountInfoResponse;
        return {};
      }),
    },
    contractAddress: "rContract",
    getAccountAddress: vi.fn(() => "rKeeperXXXXXXXXXXXXXXXXXXXXXXXXXX"),
    getWallet: vi.fn(),
    submitInvoke: overrides.submitInvoke ?? vi.fn(async () => txResult),
    readContractState: vi.fn(async () => null),
    readOracleLedgerEntry: vi.fn(),
    buildInvokeTx: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    setWallet: vi.fn(),
  } as unknown as LendingClient;
}

// Valid XRPL r-addresses for testing
const VALID_BORROWER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const VALID_BORROWER_2 = "rGjF46jKSsSmVXxXhNYHLUxm58WaA9cEfq";

function makeOpportunity(overrides: Partial<ProfitableOpportunity> = {}): ProfitableOpportunity {
  return {
    borrower: VALID_BORROWER,
    healthFactor: WAD / 2n,
    debtAsset: AssetIndex.XRP,
    collateralAsset: AssetIndex.RLUSD,
    maxDebtToRepay: 1_000_000n,        // 1 XRP in drops
    collateralToSeize: 1_100_000_000n, // 1100 RLUSD
    estimatedProfitUsd: 50n * WAD,
    netProfitUsd: 49n * WAD,
    gasCostUsd: 1n * WAD,
    ...overrides,
  };
}

// ── dry-run ───────────────────────────────────────────────────────────────────

describe("Liquidator dry-run", () => {
  it("does not call submitInvoke in dry-run mode", async () => {
    const submitInvoke = vi.fn(async () => DEFAULT_TX_RESULT);
    const client = createMockClient({ submitInvoke });
    const liquidator = new Liquidator(client, { dryRun: true, cooldownMs: 0 });

    const result = await liquidator.executeOne(makeOpportunity());

    expect(submitInvoke).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.skippedReason).toBe("dry-run");
  });

  it("returns dry-run for all items in batch", async () => {
    const client = createMockClient();
    const liquidator = new Liquidator(client, { dryRun: true, cooldownMs: 0 });

    const results = await liquidator.executeBatch([
      makeOpportunity({ borrower: "rA" }),
      makeOpportunity({ borrower: "rB" }),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.skippedReason === "dry-run")).toBe(true);
  });
});

// ── balance check ─────────────────────────────────────────────────────────────

describe("Liquidator balance check (XRP)", () => {
  it("skips when insufficient XRP balance", async () => {
    // Balance = 5_000_000 drops (5 XRP), reserve = 10_000_000, required = 1_000_000
    // 5M < 1M + 10M → insufficient
    const client = createMockClient({ accountBalance: 5_000_000n });
    const liquidator = new Liquidator(client, { dryRun: false, cooldownMs: 0 });

    const opp = makeOpportunity({ debtAsset: AssetIndex.XRP, maxDebtToRepay: 1_000_000n });
    const result = await liquidator.executeOne(opp);

    expect(result.success).toBe(false);
    expect(result.skippedReason).toBe("insufficient-balance");
  });

  it("executes when sufficient XRP balance", async () => {
    // Balance = 100_000_000 drops (100 XRP), required = 1_000_000 + 10_000_000 reserve = 11M
    const submitInvoke = vi.fn(async () => DEFAULT_TX_RESULT);
    const client = createMockClient({ accountBalance: 100_000_000n, submitInvoke });
    const liquidator = new Liquidator(client, { dryRun: false, cooldownMs: 0 });

    const opp = makeOpportunity({ debtAsset: AssetIndex.XRP, maxDebtToRepay: 1_000_000n });
    const result = await liquidator.executeOne(opp);

    expect(submitInvoke).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.txResult?.hash).toBe(DEFAULT_TX_RESULT.hash);
  });
});

// ── execution ─────────────────────────────────────────────────────────────────

describe("Liquidator execution", () => {
  it("returns success on tesSUCCESS engine result", async () => {
    const client = createMockClient();
    const liquidator = new Liquidator(client, { dryRun: false, cooldownMs: 0 });

    const result = await liquidator.executeOne(makeOpportunity());
    expect(result.success).toBe(true);
    expect(result.txResult?.engineResult).toBe("tesSUCCESS");
  });

  it("returns failure on non-success engine result", async () => {
    const failResult: TxResult = { hash: "FAIL", validated: true, engineResult: "tecNO_TARGET" };
    const submitInvoke = vi.fn(async () => failResult);
    const client = createMockClient({ submitInvoke });
    const liquidator = new Liquidator(client, { dryRun: false, cooldownMs: 0 });

    const result = await liquidator.executeOne(makeOpportunity());
    expect(result.success).toBe(false);
    expect(result.txResult?.engineResult).toBe("tecNO_TARGET");
  });

  it("handles submitInvoke exception gracefully", async () => {
    const submitInvoke = vi.fn(async () => { throw new Error("network timeout"); });
    const client = createMockClient({ submitInvoke });
    const liquidator = new Liquidator(client, { dryRun: false, cooldownMs: 0 });

    const result = await liquidator.executeOne(makeOpportunity());
    expect(result.success).toBe(false);
    expect(result.error).toContain("network timeout");
  });
});

// ── cooldown ──────────────────────────────────────────────────────────────────

describe("Liquidator cooldown", () => {
  it("batch executes all items sequentially", async () => {
    const executionOrder: string[] = [];
    const submitInvoke = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 10));
      return DEFAULT_TX_RESULT;
    });
    const client = createMockClient({ accountBalance: 100_000_000n, submitInvoke });
    const liquidator = new Liquidator(client, { dryRun: false, cooldownMs: 0 });

    await liquidator.executeBatch([
      makeOpportunity({ borrower: VALID_BORROWER,   debtAsset: AssetIndex.XRP }),
      makeOpportunity({ borrower: VALID_BORROWER_2, debtAsset: AssetIndex.XRP }),
    ]);

    expect(submitInvoke).toHaveBeenCalledTimes(2);
  });
});
