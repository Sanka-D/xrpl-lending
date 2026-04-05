import { describe, it, expect, vi } from "vitest";
import { liquidate, findLiquidatablePositions } from "../liquidation";
import { AssetIndex, WAD } from "../types";
import { LendingClient, toHex, userPositionKey, marketInterestKey } from "../client";
import { createMockClient, encodeBigintLE, mockOracleNode } from "./helpers/mock-client";

const BORROWER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const LIQUIDATOR = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

// ── liquidate ─────────────────────────────────────────────────────────────────

describe("liquidate", () => {
  it("submits invoke with correct function name", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await liquidate(client, {
      borrower: BORROWER,
      debtAsset: AssetIndex.RLUSD,
      collateralAsset: AssetIndex.WBTC,
      debtAmount: 1_000_000_000n,
    });

    expect(submitInvoke).toHaveBeenCalledOnce();
    const [fnName] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("liquidate");
  });

  it("encodes borrower AccountID in first 20 bytes of args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await liquidate(client, {
      borrower: BORROWER,
      debtAsset: AssetIndex.RLUSD,
      collateralAsset: AssetIndex.WBTC,
      debtAmount: 1_000_000_000n,
    });

    const [, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(args).toHaveLength(36);

    // First 20 bytes = borrower AccountID
    const expectedAccountId = LendingClient.addressToAccountId(BORROWER);
    expect(args.slice(0, 20)).toEqual(expectedAccountId);
  });

  it("encodes asset indices and amount correctly", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await liquidate(client, {
      borrower: BORROWER,
      debtAsset: AssetIndex.RLUSD,        // 1
      collateralAsset: AssetIndex.WBTC,   // 2
      debtAmount: 1_000_000_000n,
    });

    const [, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    // bytes 20-23: debtAsset = 1 LE
    expect(args[20]).toBe(1);
    expect(args[21]).toBe(0);
    // bytes 24-27: collateralAsset = 2 LE
    expect(args[24]).toBe(2);
    expect(args[25]).toBe(0);
    // bytes 28-35: amount = 1_000_000_000 LE
    const amountLE = args.slice(28, 36);
    let amount = 0n;
    for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(amountLE[i]);
    expect(amount).toBe(1_000_000_000n);
  });
});

// ── findLiquidatablePositions ─────────────────────────────────────────────────

describe("findLiquidatablePositions", () => {
  /**
   * Set up a borrower with HF < 1: 10,000 RLUSD collateral, 9,500 RLUSD debt.
   * HF = 10000 * 0.85 / 9500 ≈ 0.894 → liquidatable.
   */
  function buildLiquidatableStateReader(accountAddress: string) {
    const accountId = LendingClient.addressToAccountId(accountAddress);
    const i = AssetIndex.RLUSD;

    const keyMap = new Map<string, Uint8Array>([
      [toHex(userPositionKey(accountId, i, "co")), encodeBigintLE(10_000_000_000n, 16)],
      [toHex(userPositionKey(accountId, i, "de")), encodeBigintLE(9_500_000_000n, 16)],
      [toHex(userPositionKey(accountId, i, "bi")), encodeBigintLE(WAD, 16)],
      [toHex(userPositionKey(accountId, i, "sh")), encodeBigintLE(0n, 16)],
      [toHex(marketInterestKey(i, "bi")), encodeBigintLE(WAD, 16)],
      [toHex(marketInterestKey(i, "si")), encodeBigintLE(WAD, 16)],
    ]);

    return keyMap;
  }

  it("returns empty array for all healthy accounts", async () => {
    // No position state → all balances 0 → HF = MAX → not liquidatable
    const oracle = mockOracleNode({ xrpPrice: 2n * WAD, rlusdPrice: WAD, btcPrice: 60_000n * WAD });
    const client = createMockClient({
      readOracleLedgerEntry: vi.fn(async () => oracle),
    });

    const results = await findLiquidatablePositions(client, [BORROWER]);
    expect(results).toHaveLength(0);
  });

  it("returns liquidation opportunity for undercollateralized position", async () => {
    const oracle = mockOracleNode({ xrpPrice: 2n * WAD, rlusdPrice: WAD, btcPrice: 60_000n * WAD });
    const stateMap = buildLiquidatableStateReader(BORROWER);

    const readContractState = vi.fn(async (k: Uint8Array) => stateMap.get(toHex(k)) ?? null);
    const client = createMockClient({
      readOracleLedgerEntry: vi.fn(async () => oracle),
      readContractState,
    });

    const results = await findLiquidatablePositions(client, [BORROWER]);
    expect(results).toHaveLength(1);
    expect(results[0].borrower).toBe(BORROWER);
    expect(results[0].healthFactor).toBeLessThan(WAD);
    expect(results[0].debtAsset).toBe(AssetIndex.RLUSD);
    expect(results[0].maxDebtToRepay).toBeGreaterThan(0n);
    expect(results[0].collateralToSeize).toBeGreaterThan(0n);
  });
});
