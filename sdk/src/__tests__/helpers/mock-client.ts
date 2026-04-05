/**
 * Test helpers: MockLendingClient and state encoding utilities.
 */

import { vi } from "vitest";
import type { LendingClient, TxResult } from "../../client";

// ── Default happy-path mock ────────────────────────────────────────────────────

export const DEFAULT_TX_RESULT: TxResult = {
  hash: "AABBCCDDEEFF0011223344556677889900112233445566778899001122334455",
  validated: true,
  engineResult: "tesSUCCESS",
};

export function createMockClient(
  overrides: Partial<{
    submitInvoke: LendingClient["submitInvoke"];
    readContractState: LendingClient["readContractState"];
    readOracleLedgerEntry: LendingClient["readOracleLedgerEntry"];
    getAccountAddress: LendingClient["getAccountAddress"];
  }> = {},
): LendingClient {
  return {
    xrplClient: {} as unknown,
    contractAddress: "rContractXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    setWallet: vi.fn(),
    getWallet: vi.fn(() => { throw new Error("no wallet in tests"); }),
    getAccountAddress: overrides.getAccountAddress ?? vi.fn(() => "rTestUserXXXXXXXXXXXXXXXXXXXXXXXXX"),
    buildInvokeTx: vi.fn(() => ({})),
    submitInvoke: overrides.submitInvoke ?? vi.fn(async () => DEFAULT_TX_RESULT),
    readContractState: overrides.readContractState ?? vi.fn(async () => null),
    readOracleLedgerEntry: overrides.readOracleLedgerEntry ?? vi.fn(async () => ({
      LedgerEntryType: "Oracle",
      LastUpdateTime: Math.floor(Date.now() / 1000),
      PriceDataSeries: [],
    })),
  } as unknown as LendingClient;
}

// ── LE encoding helpers ────────────────────────────────────────────────────────

/** Encode a bigint as little-endian bytes (8 or 16 bytes). */
export function encodeBigintLE(value: bigint, byteLength: 8 | 16): Uint8Array {
  const buf = new Uint8Array(byteLength);
  let rem = value;
  for (let i = 0; i < byteLength; i++) {
    buf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return buf;
}

/** Build a mock state reader from a key→value map (keys as hex strings). */
export function mockStateMap(
  map: Map<string, Uint8Array>,
): (key: Uint8Array) => Promise<Uint8Array | null> {
  return async (key: Uint8Array) => {
    const hexKey = Array.from(key)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return map.get(hexKey) ?? null;
  };
}

/** Convert an ASCII string key to hex for use in mockStateMap. */
export function keyToHex(asciiKey: string): string {
  return Array.from(new TextEncoder().encode(asciiKey))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Default oracle response builder ──────────────────────────────────────────

/** Build a mock oracle ledger entry with the given prices. */
export function mockOracleNode(params: {
  xrpPrice: bigint;   // WAD-scaled, will be converted to DIA format (scale=-8)
  rlusdPrice: bigint;
  btcPrice: bigint;
  lastUpdateTime?: number;
}) {
  const { xrpPrice, rlusdPrice, btcPrice, lastUpdateTime = Math.floor(Date.now() / 1000) } = params;

  function wadToRaw(priceWad: bigint): string {
    // Invert rawToWad: assetPrice = priceWad / 10^10 (scale=-8, exponent=18+(-8)=10)
    return (priceWad / 10_000_000_000n).toString();
  }

  return {
    LedgerEntryType: "Oracle",
    LastUpdateTime: lastUpdateTime,
    PriceDataSeries: [
      { PriceData: { BaseAsset: "XRP",   QuoteAsset: "USD", AssetPrice: wadToRaw(xrpPrice),   Scale: -8 } },
      { PriceData: { BaseAsset: "RLUSD", QuoteAsset: "USD", AssetPrice: wadToRaw(rlusdPrice), Scale: -8 } },
      { PriceData: { BaseAsset: "BTC",   QuoteAsset: "USD", AssetPrice: wadToRaw(btcPrice),   Scale: -8 } },
    ],
  };
}
