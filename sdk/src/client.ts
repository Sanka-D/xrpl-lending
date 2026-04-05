/**
 * LendingClient — wraps xrpl.Client with XLS-101 contract interaction helpers.
 *
 * Two non-standard operations (not in xrpl.js v4):
 *   1. Building/submitting XLS-101 Invoke transactions
 *   2. Reading contract state via `contract_info` RPC
 */

import { Client, Wallet, decodeAccountID, encodeAccountID } from "xrpl";
import type { TxResponse, SubmittableTransaction } from "xrpl";
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

// ── LendingClient ─────────────────────────────────────────────────────────────

export class LendingClient {
  readonly xrplClient: Client;
  readonly contractAddress: string;
  private _wallet?: Wallet;

  constructor(config: LendingClientConfig) {
    this.xrplClient = new Client(config.wsUrl);
    this.contractAddress = config.contractAddress;
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
   * Build a raw XLS-101 Invoke transaction JSON.
   *
   * Encoding: HexValue = utf8_hex(functionName) + "00" + hex(args)
   * The single InvokeArg carries the full call payload.
   */
  buildInvokeTx(functionName: string, args: Uint8Array): Record<string, unknown> {
    const nameBytes = new TextEncoder().encode(functionName);
    const separator = new Uint8Array([0x00]);
    const payload = new Uint8Array(nameBytes.length + 1 + args.length);
    payload.set(nameBytes, 0);
    payload.set(separator, nameBytes.length);
    payload.set(args, nameBytes.length + 1);

    return {
      TransactionType: "Invoke",
      Account: this.getAccountAddress(),
      Destination: this.contractAddress,
      InvokeArgs: [
        { InvokeArg: { HexValue: toHex(payload).toUpperCase() } },
      ],
    };
  }

  /**
   * Submit an Invoke transaction and wait for ledger validation.
   */
  async submitInvoke(functionName: string, args: Uint8Array): Promise<TxResult> {
    const tx = this.buildInvokeTx(functionName, args);
    const wallet = this.getWallet();
    const result = await this.xrplClient.submitAndWait(
      tx as unknown as SubmittableTransaction,
      { autofill: true, wallet },
    ) as TxResponse;

    const meta = result.result.meta as Record<string, unknown> | undefined;
    const engineResult =
      typeof meta?.TransactionResult === "string"
        ? meta.TransactionResult
        : "unknown";

    return {
      hash: result.result.hash as string,
      validated: (result.result.validated as boolean) ?? false,
      engineResult,
    };
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
