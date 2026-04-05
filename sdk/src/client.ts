/**
 * LendingClient — wraps xrpl.Client with XLS-101 ContractCall helpers.
 *
 * Transaction type: ContractCall (XLS-101), encoded/signed via @transia/xrpl
 * which knows the ContractCall binary codec definitions.
 *
 * Two non-standard operations (not in standard xrpl.js v4):
 *   1. Building/submitting XLS-101 ContractCall transactions
 *   2. Reading contract state via `contract_info` RPC
 */

import { Client, Wallet, decodeAccountID, encodeAccountID } from "xrpl";
import type { TxResponse } from "xrpl";
// @transia/xrpl is a fork of xrpl.js that knows ContractCall (XLS-101) fields.
// Used exclusively for transaction encoding/signing in submitInvoke.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const transiaXrpl = require("@transia/xrpl") as {
  Wallet: typeof import("xrpl").Wallet;
};
import { LendingError, LendingErrorCode } from "./types";

// ── Public types ───────────────────────────────────────────────────────────────

export interface LendingClientConfig {
  /** WebSocket URL, e.g. "wss://s.altnet.rippletest.net:51233" */
  wsUrl: string;
  /** r-address of the deployed lending controller contract */
  contractAddress: string;
  /** Optional signing wallet; required for any write operations */
  wallet?: Wallet;
}

export interface TxResult {
  hash: string;
  validated: boolean;
  engineResult: string;
}

// ── Encoding helpers (exported for tests and other modules) ───────────────────

/** Encode a u32 as 4-byte little-endian. */
export function encodeU32LE(v: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = v & 0xff;
  buf[1] = (v >> 8) & 0xff;
  buf[2] = (v >> 16) & 0xff;
  buf[3] = (v >> 24) & 0xff;
  return buf;
}

/** Encode a u64 (as bigint) as 8-byte little-endian. */
export function encodeU64LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let rem = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return buf;
}

/** Decode a little-endian byte array (8 or 16 bytes) to bigint. */
export function decodeBigintLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/** Build the state key: "mkt:{assetIndex}:int:{field}" */
export function marketInterestKey(assetIndex: number, field: string): Uint8Array {
  const prefix = `mkt:${assetIndex}:int:`;
  return new TextEncoder().encode(prefix + field);
}

/** Build the state key: "pos:" + 20-byte accountId (binary) + ":{assetIndex}:{field}" */
export function userPositionKey(
  accountId: Uint8Array,
  assetIndex: number,
  field: string,
): Uint8Array {
  const prefix = new TextEncoder().encode("pos:");
  const mid = new TextEncoder().encode(`:${assetIndex}:`);
  const suffix = new TextEncoder().encode(field);
  const key = new Uint8Array(prefix.length + 20 + mid.length + suffix.length);
  let offset = 0;
  key.set(prefix, offset); offset += prefix.length;
  key.set(accountId, offset); offset += 20;
  key.set(mid, offset); offset += mid.length;
  key.set(suffix, offset);
  return key;
}

/** Build the state key: "glb:{field}" */
export function globalKey(field: string): Uint8Array {
  return new TextEncoder().encode(`glb:${field}`);
}

/** Convert Uint8Array to lowercase hex string. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Convert hex string to Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const normalized = clean.length % 2 === 0 ? clean : "0" + clean;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── ContractCall parameter schema ─────────────────────────────────────────────
//
// Maps each WASM export to its typed parameter list, used by argsToParameters()
// to convert the raw args Uint8Array into XLS-101 ContractCall Parameters.
//
// Encoding convention (matches the args blobs built throughout the SDK):
//   UINT32  → 4 bytes LE
//   UINT64  → 8 bytes LE
//   ACCOUNT → 20 bytes raw AccountID (encodeAccountID converts to r-address for the tx)

type ParamType = "UINT32" | "UINT64" | "ACCOUNT";

const FUNCTION_SCHEMAS: Record<string, ParamType[]> = {
  supply:              ["UINT32", "UINT64"],
  withdraw:            ["UINT32", "UINT64"],
  borrow:              ["UINT32", "UINT64"],
  repay:               ["UINT32", "UINT64"],
  deposit_collateral:  ["UINT32", "UINT64"],
  withdraw_collateral: ["UINT32", "UINT64"],
  set_vault:           ["UINT32"],
  // liquidate(borrower_ptr: u32, debt_id: u32, collat_id: u32, amount: u64)
  liquidate:           ["ACCOUNT", "UINT32", "UINT32", "UINT64"],
};

/**
 * Convert a raw args Uint8Array into a typed XLS-101 Parameters array.
 * Returns undefined for unknown functions (no parameters in the ContractCall).
 *
 * Each element is wrapped as `{ Parameter: { ParameterFlag, ParameterValue } }`
 * which satisfies the STArray codec requirement of one-key wrapper objects.
 */
function argsToParameters(
  functionName: string,
  args: Uint8Array,
): Array<{ Parameter: { ParameterFlag: number; ParameterValue: { type: string; value: string } } }> | undefined {
  const schema = FUNCTION_SCHEMAS[functionName];
  if (!schema) return undefined;

  const params: Array<{ Parameter: { ParameterFlag: number; ParameterValue: { type: string; value: string } } }> = [];
  let offset = 0;

  for (let i = 0; i < schema.length; i++) {
    const type = schema[i];
    switch (type) {
      case "UINT32": {
        const v = (args[offset] | (args[offset + 1] << 8) | (args[offset + 2] << 16) | (args[offset + 3] << 24)) >>> 0;
        params.push({ Parameter: { ParameterFlag: i, ParameterValue: { type: "UINT32", value: v.toString() } } });
        offset += 4;
        break;
      }
      case "UINT64": {
        let v = 0n;
        for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(args[offset + j]);
        params.push({ Parameter: { ParameterFlag: i, ParameterValue: { type: "UINT64", value: v.toString() } } });
        offset += 8;
        break;
      }
      case "ACCOUNT": {
        const accountId = args.slice(offset, offset + 20);
        const address = encodeAccountID(accountId);
        params.push({ Parameter: { ParameterFlag: i, ParameterValue: { type: "ACCOUNT", value: address } } });
        offset += 20;
        break;
      }
    }
  }

  return params.length > 0 ? params : undefined;
}

// ── LendingClient ─────────────────────────────────────────────────────────────

export class LendingClient {
  readonly xrplClient: Client;
  readonly contractAddress: string;
  readonly wsUrl: string;
  private _wallet?: Wallet;

  constructor(config: LendingClientConfig) {
    this.xrplClient = new Client(config.wsUrl);
    this.contractAddress = config.contractAddress;
    this.wsUrl = config.wsUrl;
    this._wallet = config.wallet;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this.xrplClient.connect();
  }

  async disconnect(): Promise<void> {
    await this.xrplClient.disconnect();
  }

  isConnected(): boolean {
    return this.xrplClient.isConnected();
  }

  // ── Wallet management ───────────────────────────────────────────────────────

  setWallet(wallet: Wallet): void {
    this._wallet = wallet;
  }

  getWallet(): Wallet {
    if (!this._wallet) {
      throw new LendingError(
        LendingErrorCode.Unauthorized,
        "No wallet configured. Call setWallet() first.",
      );
    }
    return this._wallet;
  }

  getAccountAddress(): string {
    return this.getWallet().classicAddress;
  }

  // ── Transaction building ────────────────────────────────────────────────────

  /**
   * Build an XLS-101 ContractCall transaction JSON.
   *
   * Parameters are derived from the function's schema in FUNCTION_SCHEMAS,
   * converting the raw `args` buffer into typed UINT32/UINT64/ACCOUNT entries.
   */
  buildInvokeTx(functionName: string, args: Uint8Array): Record<string, unknown> {
    const FunctionName = toHex(new TextEncoder().encode(functionName)).toUpperCase();
    const Parameters = argsToParameters(functionName, args);

    const tx: Record<string, unknown> = {
      TransactionType: "ContractCall",
      Account: this.getAccountAddress(),
      ContractAccount: this.contractAddress,
      FunctionName,
      ComputationAllowance: 1000000,
    };

    if (Parameters !== undefined) {
      tx.Parameters = Parameters;
    }

    return tx;
  }

  /**
   * Read the network ID from the connected XRPL node.
   * Used to populate the NetworkID field in ContractCall transactions.
   */
  private async getNetworkId(): Promise<number> {
    // xrpl.js v4 exposes networkID after connection
    const id = (this.xrplClient as unknown as { networkID?: number }).networkID;
    if (typeof id === "number" && id > 0) return id;

    // Fallback: query server_info
    const info = await this.xrplClient.request({
      command: "server_info",
    } as Parameters<typeof this.xrplClient.request>[0]);
    const result = (info as unknown as Record<string, unknown>).result as Record<string, unknown>;
    const serverInfo = result?.info as Record<string, unknown> | undefined;
    return (serverInfo?.network_id as number | undefined) ?? 0;
  }

  /**
   * Submit a ContractCall transaction and wait for ledger validation.
   *
   * Encoding and signing uses @transia/xrpl which knows XLS-101 ContractCall
   * binary codec definitions (not present in standard xrpl.js v4).
   */
  async submitInvoke(functionName: string, args: Uint8Array): Promise<TxResult> {
    const wallet = this.getWallet();
    const networkId = await this.getNetworkId();

    // 1. Autofill: get current sequence number via HTTP RPC (avoids api_version: 2
    //    incompatibility with local Bedrock nodes that only support api_version: 1)
    const wsUrl = this.wsUrl;
    const rpcUrl = wsUrl.replace("wss://", "https://").replace("ws://", "http://")
      .replace(":6006", ":5005").replace(":51233", ":51234");

    const acctRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "account_info",
        params: [{ account: wallet.classicAddress, ledger_index: "current" }],
      }),
    });
    const acctJson = await acctRes.json() as Record<string, unknown>;
    const acctResult = acctJson.result as Record<string, unknown>;
    const data = acctResult.account_data as Record<string, unknown>;

    // 2. Build the ContractCall transaction
    const tx = this.buildInvokeTx(functionName, args);
    tx.Sequence = data.Sequence as number;
    tx.Fee = "1000000"; // 1 XRP — generous for contract calls
    tx.SigningPubKey = wallet.publicKey;
    tx.Flags = 0;
    if (networkId > 0) {
      tx.NetworkID = networkId;
    }

    // 3. Sign using @transia/xrpl (knows ContractCall binary encoding)
    const transiaWallet = new transiaXrpl.Wallet(wallet.publicKey, wallet.privateKey!);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signed = (transiaWallet as any).sign(tx) as { tx_blob: string; hash: string };

    // 4. Submit via HTTP RPC (rpcUrl already derived above)
    let hash = signed.hash;

    try {
      const submitRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "submit", params: [{ tx_blob: signed.tx_blob }] }),
      });
      const submitJson = await submitRes.json() as Record<string, unknown>;
      const submitResult = submitJson.result as Record<string, unknown>;
      hash = (submitResult.tx_json as Record<string, unknown>)?.hash as string ?? hash;
      const engineResult = submitResult.engine_result as string ?? "unknown";

      if (engineResult !== "tesSUCCESS" && !engineResult.startsWith("ter")) {
        return { hash, validated: false, engineResult };
      }
    } catch {
      // Fallback: WebSocket submit
      const subRes = await this.xrplClient.request({
        command: "submit",
        tx_blob: signed.tx_blob,
      } as Parameters<typeof this.xrplClient.request>[0]);
      const r = (subRes as unknown as Record<string, unknown>).result as Record<string, unknown>;
      hash = ((r.tx_json as Record<string, unknown>)?.hash as string) ?? hash;
    }

    // 5. Poll for validation (up to 30s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const txRes = await this.xrplClient.request({
          command: "tx",
          transaction: hash,
        } as Parameters<typeof this.xrplClient.request>[0]);
        const r = (txRes as unknown as Record<string, unknown>).result as Record<string, unknown>;
        if (r.validated) {
          const meta = r.meta as Record<string, unknown> | undefined;
          return {
            hash,
            validated: true,
            engineResult: (meta?.TransactionResult as string) ?? "tesSUCCESS",
          };
        }
      } catch {
        // not yet found
      }
    }

    return { hash, validated: false, engineResult: "timeout" };
  }

  // ── State reads ─────────────────────────────────────────────────────────────

  /**
   * Read a single state entry from contract storage.
   *
   * Uses the `contract_info` RPC (XLS-101). Returns null if key not found.
   */
  async readContractState(key: Uint8Array): Promise<Uint8Array | null> {
    try {
      const response = await this.xrplClient.request({
        command: "contract_info" as "ledger_entry",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(({ contract: this.contractAddress, key: toHex(key) }) as any),
      } as unknown as Parameters<typeof this.xrplClient.request>[0]);

      const node = (response as unknown as Record<string, unknown>).result as Record<string, unknown>;
      const hexValue = node?.value as string | undefined;
      if (!hexValue) return null;
      return fromHex(hexValue);
    } catch {
      return null;
    }
  }

  /**
   * Read the DIA oracle ledger entry (XLS-47 Oracle object).
   * Returns the raw node object containing PriceDataSeries.
   */
  async readOracleLedgerEntry(
    oracleAccount: string,
    documentId: number,
  ): Promise<Record<string, unknown>> {
    const response = await this.xrplClient.request({
      command: "ledger_entry",
      oracle: {
        account: oracleAccount,
        oracle_document_id: documentId,
      },
    } as Parameters<typeof this.xrplClient.request>[0]);

    const result = (response as unknown as Record<string, unknown>).result as Record<string, unknown>;
    const node = result?.node as Record<string, unknown>;
    if (!node) {
      throw new LendingError(LendingErrorCode.OracleNotConfigured, "Oracle ledger entry not found");
    }
    return node;
  }

  // ── Address utilities (static) ──────────────────────────────────────────────

  /** Convert an r-address to its raw 20-byte AccountID. */
  static addressToAccountId(rAddress: string): Uint8Array {
    return decodeAccountID(rAddress);
  }

  /** Convert a raw 20-byte AccountID to an r-address. */
  static accountIdToAddress(accountId: Uint8Array): string {
    return encodeAccountID(accountId);
  }
}
