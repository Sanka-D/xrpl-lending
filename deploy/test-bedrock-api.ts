/**
 * Test the Bedrock host_lib API with a minimal contract.
 *
 * Contract functions:
 *   accept_only() → just calls finish(0) → expect tesSUCCESS
 *   read_param()  → reads function_param(0, UINT32), if==42 accept else fail
 *   write_state() → get_tx_field(Account), set_data_object_field("counter"=1), accept
 */
import { readFileSync } from "fs";
import { createRequire } from "module";
import { Client, Wallet } from "xrpl";
import type { SubmittableTransaction } from "xrpl";
import { loadDeployEnv, loadDeployWallet, log } from "./shared.js";

const _require = createRequire(import.meta.url);
const transiaXrpl = _require("xrpl-lending-sdk/node_modules/@transia/xrpl") as { Wallet: typeof Wallet };

const WASM_PATH = "../contracts/bedrock-test-contract/target/wasm32-unknown-unknown/release/bedrock_test_contract.wasm";

async function getAcct(rpcUrl: string, addr: string): Promise<Record<string, unknown>> {
  const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "account_info", params: [{ account: addr, ledger_index: "current" }] }) });
  return ((await res.json() as Record<string, unknown>).result as Record<string, unknown>).account_data as Record<string, unknown>;
}

async function submitAndWait(
  rpcUrl: string, client: Client, wallet: Wallet,
  tx: Record<string, unknown>, networkId: number, label: string,
): Promise<string> {
  const acct = await getAcct(rpcUrl, wallet.classicAddress);
  tx.Sequence = acct.Sequence;
  tx.Fee = "1000000";
  tx.SigningPubKey = wallet.publicKey;
  tx.Flags = 0;
  tx.NetworkID = networkId;

  const tw = new transiaXrpl.Wallet(wallet.publicKey, (wallet as unknown as { privateKey: string }).privateKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = (tw as any).sign(tx) as { tx_blob: string; hash: string };

  try {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "submit", params: [{ tx_blob: signed.tx_blob }] }) });
    const res = (await r.json() as Record<string, unknown>).result as Record<string, unknown>;
    const eng = res.engine_result as string ?? "unknown";
    log(`${label}: submit → ${eng}`);

    const hash = ((res.tx_json as Record<string, unknown>)?.hash as string) ?? signed.hash;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const txr = await client.request({ command: "tx", transaction: hash } as Parameters<typeof client.request>[0]);
        const r = (txr as unknown as Record<string, unknown>).result as Record<string, unknown>;
        if (r.validated) {
          const result = (r.meta as Record<string, unknown>)?.TransactionResult as string ?? "unknown";
          log(`${label}: ledger → ${result}`);
          return result;
        }
      } catch { /* not yet */ }
    }
    return "timeout";
  } catch (e) {
    log(`${label}: CRASH - ${(e as Error).message}`);
    return "crash";
  }
}

async function isAlive(rpcUrl: string): Promise<boolean> {
  try {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "ping", params: [{}] }) });
    const d = await r.json() as Record<string, unknown>;
    return (d.result as Record<string, unknown>)?.status === "success";
  } catch { return false; }
}

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const wallet = loadDeployWallet(env.deployerSecret);
  const wsUrl = env.wsUrl;
  const rpcUrl = wsUrl.replace("ws://", "http://").replace(":6006", ":5005");

  const si = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "server_info", params: [{}] }) });
  const networkId = (((await si.json() as Record<string, unknown>).result as Record<string, unknown>).info as Record<string, unknown>)?.network_id as number ?? 0;
  log(`Network ID: ${networkId}`);

  const wasmHex = readFileSync(WASM_PATH).toString("hex").toUpperCase();
  log(`WASM size: ${wasmHex.length / 2} bytes`);

  const client = new Client(wsUrl);
  await client.connect();

  try {
    // Deploy test contract with all 3 functions
    const fns = ["accept_only", "read_param", "write_state"];
    const acct = await getAcct(rpcUrl, wallet.classicAddress);
    const deployTx: Record<string, unknown> = {
      TransactionType: "ContractCreate",
      Account: wallet.classicAddress,
      ContractCode: wasmHex,
      Functions: fns.map(n => ({ Function: { FunctionName: Buffer.from(n).toString("hex").toUpperCase() } })),
      Fee: "1000000",
      Sequence: acct.Sequence,
      SigningPubKey: wallet.publicKey,
      Flags: 0,
      NetworkID: networkId,
    };
    const tw = new transiaXrpl.Wallet(wallet.publicKey, (wallet as unknown as { privateKey: string }).privateKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signed = (tw as any).sign(deployTx) as { tx_blob: string; hash: string };
    const dr = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "submit", params: [{ tx_blob: signed.tx_blob }] }) });
    const dres = (await dr.json() as Record<string, unknown>).result as Record<string, unknown>;
    log(`Deploy: ${dres.engine_result}`);

    // Wait for deploy
    await new Promise(r => setTimeout(r, 3000));
    let contract: string | null = null;
    for (let i = 0; i < 15; i++) {
      try {
        const txr = await client.request({ command: "tx", transaction: signed.hash } as Parameters<typeof client.request>[0]);
        const r = (txr as unknown as Record<string, unknown>).result as Record<string, unknown>;
        if (r.validated) {
          const meta = r.meta as Record<string, unknown>;
          log(`Deploy ledger result: ${meta.TransactionResult}`);
          for (const node of ((meta.AffectedNodes as unknown[]) ?? [])) {
            const n = node as Record<string, unknown>;
            if ((n.CreatedNode as Record<string, unknown>)?.LedgerEntryType === "AccountRoot") {
              contract = ((n.CreatedNode as Record<string, unknown>).NewFields as Record<string, unknown>).Account as string;
            }
          }
          break;
        }
      } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!contract) { log("Deploy failed!"); return; }
    log(`Contract: ${contract}`);

    // Test 1: accept_only (no params)
    log("\n--- Test 1: accept_only (no params) ---");
    await submitAndWait(rpcUrl, client, wallet, {
      TransactionType: "ContractCall",
      Account: wallet.classicAddress,
      ContractAccount: contract,
      FunctionName: Buffer.from("accept_only").toString("hex").toUpperCase(),
      ComputationAllowance: 1000000,
    }, networkId, "accept_only");
    log(`Node alive: ${await isAlive(rpcUrl)}`);

    // Test 2: read_param with no params (param[0] would be 0, not 42 → should fail)
    log("\n--- Test 2: read_param (no params → param=0 ≠ 42 → proc_exit(1)) ---");
    await submitAndWait(rpcUrl, client, wallet, {
      TransactionType: "ContractCall",
      Account: wallet.classicAddress,
      ContractAccount: contract,
      FunctionName: Buffer.from("read_param").toString("hex").toUpperCase(),
      ComputationAllowance: 1000000,
    }, networkId, "read_param (no params)");
    log(`Node alive: ${await isAlive(rpcUrl)}`);

    // Test 3: write_state (no params)
    log("\n--- Test 3: write_state (get caller, write counter=1, accept) ---");
    await submitAndWait(rpcUrl, client, wallet, {
      TransactionType: "ContractCall",
      Account: wallet.classicAddress,
      ContractAccount: contract,
      FunctionName: Buffer.from("write_state").toString("hex").toUpperCase(),
      ComputationAllowance: 1000000,
    }, networkId, "write_state");
    log(`Node alive: ${await isAlive(rpcUrl)}`);

  } finally {
    await client.disconnect();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
