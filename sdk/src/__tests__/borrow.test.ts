import { describe, it, expect, vi } from "vitest";
import { borrow, repay, getDebtBalance } from "../borrow";
import { AssetIndex, WAD } from "../types";
import { encodeU32LE, encodeU64LE, toHex, userPositionKey, marketInterestKey } from "../client";
import { LendingClient } from "../client";
import { createMockClient, encodeBigintLE } from "./helpers/mock-client";

const TEST_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

// ── borrow ────────────────────────────────────────────────────────────────────

describe("borrow", () => {
  it("submits invoke with correct function name and args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await borrow(client, AssetIndex.RLUSD, 1_000_000_000n);

    const [fnName, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("borrow");
    const expected = new Uint8Array(12);
    expected.set(encodeU32LE(AssetIndex.RLUSD), 0);
    expected.set(encodeU64LE(1_000_000_000n), 4);
    expect(args).toEqual(expected);
  });
});

// ── repay ─────────────────────────────────────────────────────────────────────

describe("repay", () => {
  it("submits invoke with correct function name and args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await repay(client, AssetIndex.RLUSD, 500_000_000n);

    const [fnName, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("repay");
    const expected = new Uint8Array(12);
    expected.set(encodeU32LE(AssetIndex.RLUSD), 0);
    expected.set(encodeU64LE(500_000_000n), 4);
    expect(args).toEqual(expected);
  });
});

// ── getDebtBalance ────────────────────────────────────────────────────────────

describe("getDebtBalance", () => {
  it("returns 0 when no debt state", async () => {
    const client = createMockClient();
    const debt = await getDebtBalance(client, TEST_ADDRESS, AssetIndex.RLUSD);
    expect(debt).toBe(0n);
  });

  it("returns principal unchanged when index = 1.0", async () => {
    const principal = 5_000_000_000n; // 5000 RLUSD
    const accountId = LendingClient.addressToAccountId(TEST_ADDRESS);

    const keyMap = new Map([
      [toHex(userPositionKey(accountId, AssetIndex.RLUSD, "de")), encodeBigintLE(principal, 16)],
      [toHex(userPositionKey(accountId, AssetIndex.RLUSD, "bi")), encodeBigintLE(WAD, 16)],
      [toHex(marketInterestKey(AssetIndex.RLUSD, "bi")),          encodeBigintLE(WAD, 16)],
    ]);

    const readContractState = vi.fn(async (k: Uint8Array) => keyMap.get(toHex(k)) ?? null);
    const client = createMockClient({ readContractState });

    const debt = await getDebtBalance(client, TEST_ADDRESS, AssetIndex.RLUSD);
    expect(debt).toBe(principal);
  });

  it("doubles debt when borrow index doubled", async () => {
    const principal = 5_000_000_000n;
    const accountId = LendingClient.addressToAccountId(TEST_ADDRESS);

    const keyMap = new Map([
      [toHex(userPositionKey(accountId, AssetIndex.RLUSD, "de")), encodeBigintLE(principal, 16)],
      [toHex(userPositionKey(accountId, AssetIndex.RLUSD, "bi")), encodeBigintLE(WAD, 16)],
      [toHex(marketInterestKey(AssetIndex.RLUSD, "bi")),          encodeBigintLE(WAD * 2n, 16)],
    ]);

    const readContractState = vi.fn(async (k: Uint8Array) => keyMap.get(toHex(k)) ?? null);
    const client = createMockClient({ readContractState });

    const debt = await getDebtBalance(client, TEST_ADDRESS, AssetIndex.RLUSD);
    expect(debt).toBe(principal * 2n);
  });
});
