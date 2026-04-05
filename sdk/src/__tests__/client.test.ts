import { describe, it, expect } from "vitest";
import {
  LendingClient,
  encodeU32LE,
  encodeU64LE,
  decodeBigintLE,
  marketInterestKey,
  userPositionKey,
  globalKey,
  toHex,
  fromHex,
} from "../client";

// ── Encoding helpers ──────────────────────────────────────────────────────────

describe("encodeU32LE", () => {
  it("encodes 0", () => {
    expect(encodeU32LE(0)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("encodes 1 as first byte", () => {
    expect(encodeU32LE(1)).toEqual(new Uint8Array([1, 0, 0, 0]));
  });

  it("encodes 256", () => {
    expect(encodeU32LE(256)).toEqual(new Uint8Array([0, 1, 0, 0]));
  });

  it("encodes max u32", () => {
    expect(encodeU32LE(0xffffffff)).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  });
});

describe("encodeU64LE / decodeBigintLE roundtrip", () => {
  it("zero", () => {
    const enc = encodeU64LE(0n);
    expect(decodeBigintLE(enc)).toBe(0n);
  });

  it("value 1", () => {
    const enc = encodeU64LE(1n);
    expect(decodeBigintLE(enc)).toBe(1n);
  });

  it("large u64", () => {
    const v = 100_000_000_000_000_000n;
    expect(decodeBigintLE(encodeU64LE(v))).toBe(v);
  });

  it("u128 (16 bytes) roundtrip", () => {
    const v = 10n ** 30n;
    const buf = new Uint8Array(16);
    let rem = v;
    for (let i = 0; i < 16; i++) { buf[i] = Number(rem & 0xffn); rem >>= 8n; }
    expect(decodeBigintLE(buf)).toBe(v);
  });
});

// ── State key builders ────────────────────────────────────────────────────────

describe("marketInterestKey", () => {
  it("generates correct key for asset 0, field 'br'", () => {
    const key = marketInterestKey(0, "br");
    expect(new TextDecoder().decode(key)).toBe("mkt:0:int:br");
  });

  it("generates correct key for asset 2, field 'bi'", () => {
    const key = marketInterestKey(2, "bi");
    expect(new TextDecoder().decode(key)).toBe("mkt:2:int:bi");
  });
});

describe("userPositionKey", () => {
  it("starts with 'pos:' prefix", () => {
    const accountId = new Uint8Array(20);
    const key = userPositionKey(accountId, 0, "co");
    expect(new TextDecoder().decode(key.slice(0, 4))).toBe("pos:");
  });

  it("embeds 20 raw account bytes", () => {
    const accountId = new Uint8Array(20).fill(0xab);
    const key = userPositionKey(accountId, 0, "co");
    expect(key.slice(4, 24)).toEqual(accountId);
  });

  it("ends with asset index and field", () => {
    const accountId = new Uint8Array(20);
    const key = userPositionKey(accountId, 1, "de");
    const tail = new TextDecoder().decode(key.slice(24));
    expect(tail).toBe(":1:de");
  });
});

describe("globalKey", () => {
  it("generates 'glb:vault0'", () => {
    const key = globalKey("vault0");
    expect(new TextDecoder().decode(key)).toBe("glb:vault0");
  });
});

// ── Hex utilities ─────────────────────────────────────────────────────────────

describe("toHex / fromHex", () => {
  it("roundtrip", () => {
    const bytes = new Uint8Array([0x01, 0xab, 0xcd, 0xef]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("handles 0x prefix", () => {
    expect(fromHex("0xff")).toEqual(new Uint8Array([0xff]));
  });

  it("lowercase hex", () => {
    expect(toHex(new Uint8Array([255]))).toBe("ff");
  });
});

// ── Address utilities ─────────────────────────────────────────────────────────

describe("LendingClient address utils", () => {
  it("addressToAccountId roundtrip", () => {
    const address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    const accountId = LendingClient.addressToAccountId(address);
    expect(accountId).toHaveLength(20);
    expect(LendingClient.accountIdToAddress(accountId)).toBe(address);
  });

  it("different addresses produce different AccountIDs", () => {
    const a = LendingClient.addressToAccountId("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    const b = LendingClient.addressToAccountId("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe");
    expect(toHex(a)).not.toBe(toHex(b));
  });
});

// ── buildInvokeTx ─────────────────────────────────────────────────────────────

describe("buildInvokeTx", () => {
  const config = {
    wsUrl: "wss://test",
    contractAddress: "rContractXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    wallet: { classicAddress: "rCallerXXXXXXXXXXXXXXXXXXXXXXXXXXX", publicKey: "ED0000", privateKey: undefined } as unknown as import("xrpl").Wallet,
  };

  it("produces ContractCall transaction type", () => {
    const client = new LendingClient(config);
    // supply(asset_id: u32, amount: u64) → 12 bytes
    const args = new Uint8Array([...encodeU32LE(0), ...encodeU64LE(1000000n)]);
    const tx = client.buildInvokeTx("supply", args);

    expect(tx.TransactionType).toBe("ContractCall");
    expect(tx.ContractAccount).toBe("rContractXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  });

  it("FunctionName is uppercase hex of function name UTF-8", () => {
    const client = new LendingClient(config);
    const args = new Uint8Array([...encodeU32LE(0), ...encodeU64LE(0n)]);
    const tx = client.buildInvokeTx("supply", args);

    // "supply" in UTF-8 hex = 737570706C79 (uppercase)
    expect(tx.FunctionName).toBe("737570706C79".toUpperCase());
  });

  it("Parameters typed correctly for supply (UINT32, UINT64)", () => {
    const client = new LendingClient(config);
    const args = new Uint8Array([...encodeU32LE(1), ...encodeU64LE(500n)]);
    const tx = client.buildInvokeTx("supply", args);

    type Param = { Parameter: { ParameterFlag: number; ParameterValue: { type: string; value: string } } };
    const params = tx.Parameters as Param[];
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({ Parameter: { ParameterFlag: 0, ParameterValue: { type: "UINT32", value: "1" } } });
    expect(params[1]).toMatchObject({ Parameter: { ParameterFlag: 1, ParameterValue: { type: "UINT64", value: "500" } } });
  });

  it("Parameters typed correctly for set_vault (UINT32 only — caller becomes vault)", () => {
    const client = new LendingClient(config);
    const args = encodeU32LE(2);
    const tx = client.buildInvokeTx("set_vault", args);

    type Param = { Parameter: { ParameterFlag: number; ParameterValue: { type: string; value: string } } };
    const params = tx.Parameters as Param[];
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ Parameter: { ParameterFlag: 0, ParameterValue: { type: "UINT32", value: "2" } } });
  });
});
