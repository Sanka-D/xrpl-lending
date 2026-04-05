import { describe, it, expect, vi } from "vitest";
import { depositCollateral, withdrawCollateral, getCollateralBalance } from "../collateral";
import { AssetIndex } from "../types";
import { encodeU32LE, encodeU64LE, toHex, userPositionKey } from "../client";
import { LendingClient } from "../client";
import { createMockClient, encodeBigintLE } from "./helpers/mock-client";

const TEST_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

// ── depositCollateral ─────────────────────────────────────────────────────────

describe("depositCollateral", () => {
  it("submits invoke with correct function name and args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await depositCollateral(client, AssetIndex.WBTC, 100_000_000n);

    const [fnName, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("deposit_collateral");
    const expected = new Uint8Array(12);
    expected.set(encodeU32LE(AssetIndex.WBTC), 0);
    expected.set(encodeU64LE(100_000_000n), 4);
    expect(args).toEqual(expected);
  });
});

// ── withdrawCollateral ────────────────────────────────────────────────────────

describe("withdrawCollateral", () => {
  it("submits invoke with correct function name and args", async () => {
    const submitInvoke = vi.fn(async () => ({ hash: "H", validated: true, engineResult: "tesSUCCESS" }));
    const client = createMockClient({ submitInvoke });

    await withdrawCollateral(client, AssetIndex.XRP, 5_000_000n);

    const [fnName, args] = submitInvoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(fnName).toBe("withdraw_collateral");
    const expected = new Uint8Array(12);
    expected.set(encodeU32LE(AssetIndex.XRP), 0);
    expected.set(encodeU64LE(5_000_000n), 4);
    expect(args).toEqual(expected);
  });
});

// ── getCollateralBalance ──────────────────────────────────────────────────────

describe("getCollateralBalance", () => {
  it("returns 0 when not found", async () => {
    const client = createMockClient();
    expect(await getCollateralBalance(client, TEST_ADDRESS, AssetIndex.XRP)).toBe(0n);
  });

  it("decodes collateral from state", async () => {
    const amount = 10_000_000n; // 10 XRP
    const accountId = LendingClient.addressToAccountId(TEST_ADDRESS);
    const key = userPositionKey(accountId, AssetIndex.XRP, "co");

    const readContractState = vi.fn(async (k: Uint8Array) =>
      toHex(k) === toHex(key) ? encodeBigintLE(amount, 16) : null,
    );
    const client = createMockClient({ readContractState });

    expect(await getCollateralBalance(client, TEST_ADDRESS, AssetIndex.XRP)).toBe(amount);
  });
});
