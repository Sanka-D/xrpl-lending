import { describe, it, expect, vi } from "vitest";
import { supply, withdraw, getSupplyShares, getInterestState } from "../supply";
import { AssetIndex, WAD } from "../types";
import { encodeU32LE, encodeU64LE, toHex, userPositionKey, marketInterestKey } from "../client";
import { LendingClient } from "../client";
import { createMockClient, encodeBigintLE, keyToHex } from "./helpers/mock-client";

// ── supply ────────────────────────────────────────────────────────────────────

describe("supply", () => {
  it("submits invoke with correct function name and args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await supply(client, AssetIndex.RLUSD, 5_000_000_000n);

    expect(submitInvoke).toHaveBeenCalledOnce();
    const [fnName, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("supply");
    // args = u32LE(1) + u64LE(5_000_000_000)
    const expectedArgs = new Uint8Array(12);
    expectedArgs.set(encodeU32LE(AssetIndex.RLUSD), 0);
    expectedArgs.set(encodeU64LE(5_000_000_000n), 4);
    expect(args).toEqual(expectedArgs);
  });
});

// ── withdraw ──────────────────────────────────────────────────────────────────

describe("withdraw", () => {
  it("submits invoke with correct function name and args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await withdraw(client, AssetIndex.XRP, 1_000_000n);

    expect(submitInvoke).toHaveBeenCalledOnce();
    const [fnName, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("withdraw");
    const expectedArgs = new Uint8Array(12);
    expectedArgs.set(encodeU32LE(AssetIndex.XRP), 0);
    expectedArgs.set(encodeU64LE(1_000_000n), 4);
    expect(args).toEqual(expectedArgs);
  });
});

// ── getSupplyShares ───────────────────────────────────────────────────────────

describe("getSupplyShares", () => {
  const TEST_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

  it("returns 0 when state key not found", async () => {
    const client = createMockClient();
    const shares = await getSupplyShares(client, TEST_ADDRESS, AssetIndex.XRP);
    expect(shares).toBe(0n);
  });

  it("decodes LE-encoded u128 shares from state", async () => {
    const expectedShares = 3_141_592_653n;
    const accountId = LendingClient.addressToAccountId(TEST_ADDRESS);
    const key = userPositionKey(accountId, AssetIndex.RLUSD, "sh");
    const keyHex = toHex(key);

    const readContractState = vi.fn(async (k: Uint8Array) => {
      if (toHex(k) === keyHex) return encodeBigintLE(expectedShares, 16);
      return null;
    });
    const client = createMockClient({ readContractState });

    const shares = await getSupplyShares(client, TEST_ADDRESS, AssetIndex.RLUSD);
    expect(shares).toBe(expectedShares);
  });
});

// ── getInterestState ──────────────────────────────────────────────────────────

describe("getInterestState", () => {
  it("defaults to WAD borrow/supply index when state not found", async () => {
    const client = createMockClient();
    const state = await getInterestState(client, AssetIndex.XRP);
    expect(state.borrowIndex).toBe(WAD);
    expect(state.supplyIndex).toBe(WAD);
    expect(state.totalBorrows).toBe(0n);
    expect(state.totalSupply).toBe(0n);
  });

  it("assembles all 7 fields correctly from state", async () => {
    const keyHexMap = new Map<string, Uint8Array>([
      [toHex(marketInterestKey(0, "br")), encodeBigintLE(400n, 8)],
      [toHex(marketInterestKey(0, "sr")), encodeBigintLE(200n, 8)],
      [toHex(marketInterestKey(0, "bi")), encodeBigintLE(WAD * 2n, 16)],
      [toHex(marketInterestKey(0, "si")), encodeBigintLE(WAD * 15n / 10n, 16)],
      [toHex(marketInterestKey(0, "ts")), encodeBigintLE(1_700_000_000n, 8)],
      [toHex(marketInterestKey(0, "tb")), encodeBigintLE(50_000_000_000n, 16)],
      [toHex(marketInterestKey(0, "tp")), encodeBigintLE(100_000_000_000n, 16)],
    ]);

    const readContractState = vi.fn(async (k: Uint8Array) => keyHexMap.get(toHex(k)) ?? null);
    const client = createMockClient({ readContractState });

    const state = await getInterestState(client, AssetIndex.XRP);
    expect(state.borrowRateBps).toBe(400);
    expect(state.supplyRateBps).toBe(200);
    expect(state.borrowIndex).toBe(WAD * 2n);
    expect(state.supplyIndex).toBe(WAD * 15n / 10n);
    expect(state.lastUpdateTimestamp).toBe(1_700_000_000);
    expect(state.totalBorrows).toBe(50_000_000_000n);
    expect(state.totalSupply).toBe(100_000_000_000n);
  });
});
