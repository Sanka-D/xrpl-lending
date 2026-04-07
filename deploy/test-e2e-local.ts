/**
 * End-to-end smoke test for state-only lending operations on local Bedrock node.
 *
 * All functions use no Parameters (Parameters crash Bedrock — known bug).
 * Fallback defaults hardcoded in lib.rs:
 *   asset_id=0 (XRP), amount=1_000_000 drops (supply/deposit/repay), 500_000 drops (borrow).
 *
 * Sequence:
 *   1. set_vault()             → genesis registers itself as XRP vault (asset_id=0)
 *   2. supply()                → supply 1M drops to XRP pool → tesSUCCESS ✅
 *   3. deposit_collateral()    → deposit 1M drops as collateral → tesSUCCESS ✅
 *   4. borrow()                → borrow 500K drops ($1.075 < 70% LTV of $2.15) → tesSUCCESS ✅
 *   5. repay()                 → repay 500K drops → tesSUCCESS ✅
 *   6. withdraw_collateral()   → withdraw collateral → tesSUCCESS ✅
 *   7. withdraw()              → redeem supply shares → tesSUCCESS ✅
 */
import { createRequire } from "module";
import { Client, Wallet } from "xrpl";
import { loadDeployEnv, loadDeployWallet, loadDeployedState, log } from "./shared.js";

const _require = createRequire(import.meta.url);
const transiaXrpl = _require("xrpl-lending-sdk/node_modules/@transia/xrpl") as { Wallet: typeof Wallet };

async function getSeq(rpcUrl: string, addr: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "account_info", params: [{ account: addr, ledger_index: "current" }] }),
  });
  const d = (await res.json() as Record<string, unknown>).result as Record<string, unknown>;
  return (d.account_data as Record<string, unknown>).Sequence as number;
}

async function callFn(
  rpcUrl: string,
  client: Client,
  wallet: Wallet,
  contract: string,
  fnName: string,
  networkId: number,
  label: string,
): Promise<string> {
  const seq = await getSeq(rpcUrl, wallet.classicAddress);
  const fnHex = Buffer.from(fnName).toString("hex").toUpperCase();
  const tx = {
    TransactionType: "ContractCall",
    Account: wallet.classicAddress,
    ContractAccount: contract,
    FunctionName: fnHex,
    ComputationAllowance: 1000000,
    Fee: "1000000",
    Sequence: seq,
    SigningPubKey: wallet.publicKey,
    Flags: 0,
    NetworkID: networkId,
  };

  const tw = new transiaXrpl.Wallet(wallet.publicKey, (wallet as unknown as { privateKey: string }).privateKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = (tw as any).sign(tx) as { tx_blob: string; hash: string };

  const r = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "submit", params: [{ tx_blob: signed.tx_blob }] }),
  });
  const res = (await r.json() as Record<string, unknown>).result as Record<string, unknown>;
  const submitResult = res.engine_result as string;
  log(`${label} (submit): ${submitResult}`);

  // Wait for validation
  const hash = ((res.tx_json as Record<string, unknown>)?.hash as string) ?? signed.hash;
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const txr = await client.request({ command: "tx", transaction: hash } as Parameters<typeof client.request>[0]);
      const r2 = (txr as unknown as Record<string, unknown>).result as Record<string, unknown>;
      if (r2.validated) {
        const result = (r2.meta as Record<string, unknown>)?.TransactionResult as string ?? "unknown";
        log(`${label} (ledger): ${result}`);
        return result;
      }
    } catch { /* not yet */ }
  }
  return "timeout";
}

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const wallet = loadDeployWallet(env.deployerSecret);
  const state = loadDeployedState();
  if (!state?.controllerAddress) {
    log("No deployed.json with controllerAddress. Run deploy-controller.ts first.");
    process.exit(1);
  }
  const contract = state.controllerAddress;
  const wsUrl = env.wsUrl;
  const rpcUrl = wsUrl.replace("ws://", "http://").replace(":6006", ":5005");

  const si = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "server_info", params: [{}] }),
  });
  const networkId = (((await si.json() as Record<string, unknown>).result as Record<string, unknown>).info as Record<string, unknown>)?.network_id as number ?? 0;
  log(`Contract: ${contract}, NetworkID: ${networkId}`);

  const client = new Client(wsUrl);
  await client.connect();

  const results: Record<string, string> = {};

  try {
    // 1. set_vault (asset_id=0 default → registers genesis as XRP vault)
    log("\n=== 1. set_vault (asset_id=0, caller=genesis) ===");
    results.set_vault = await callFn(rpcUrl, client, wallet, contract, "set_vault", networkId, "set_vault");
    log(`→ ${results.set_vault} ${results.set_vault === "tesSUCCESS" ? "✅" : "❌"}`);

    // 2. supply (asset_id=0, amount=1_000_000 drops default)
    log("\n=== 2. supply (XRP, 1M drops) ===");
    results.supply = await callFn(rpcUrl, client, wallet, contract, "supply", networkId, "supply");
    log(`→ ${results.supply} ${results.supply === "tesSUCCESS" ? "✅" : "❌"}`);

    // 3. deposit_collateral (asset_id=0, amount=1_000_000 drops)
    log("\n=== 3. deposit_collateral (XRP, 1M drops) ===");
    results.deposit_collateral = await callFn(rpcUrl, client, wallet, contract, "deposit_collateral", networkId, "deposit_collateral");
    log(`→ ${results.deposit_collateral} ${results.deposit_collateral === "tesSUCCESS" ? "✅" : "❌"}`);

    // 3b. Probes to diagnose borrow failure
    // Call probe_supply_state TWICE: 1st writes sentinel, 2nd reads it back.
    // data_ok on 2nd call = update_data persists across TXes ✅
    log("\n=== 3b-1. probe_supply_state (WRITE sentinel) ===");
    results.probe_supply_state = await callFn(rpcUrl, client, wallet, contract, "probe_supply_state", networkId, "probe_supply_state");
    log(`→ ${results.probe_supply_state} ${results.probe_supply_state === "tesSUCCESS" ? "✅ wrote" : "❌"}`);

    log("\n=== 3b-2. probe_supply_state (READ back — data_ok means update_data persists) ===");
    results.probe_supply_state2 = await callFn(rpcUrl, client, wallet, contract, "probe_supply_state", networkId, "probe_supply_state2");
    log(`→ ${results.probe_supply_state2} ${results.probe_supply_state2 === "tesSUCCESS" ? "✅ data persisted!" : "❌ no persistence"}`);

    log("\n=== 3c. probe_collateral (collateral > 0?) ===");
    results.probe_collateral = await callFn(rpcUrl, client, wallet, contract, "probe_collateral", networkId, "probe_collateral");
    log(`→ ${results.probe_collateral} ${results.probe_collateral === "tesSUCCESS" ? "✅ collateral > 0" : "❌ collateral = 0 (position read failed)"}`);

    log("\n=== 3d. probe_oracle (oracle prices ok?) ===");
    results.probe_oracle = await callFn(rpcUrl, client, wallet, contract, "probe_oracle", networkId, "probe_oracle");
    log(`→ ${results.probe_oracle} ${results.probe_oracle === "tesSUCCESS" ? "✅ oracle ok" : "❌ oracle failed"}`);

    // 4. borrow (asset_id=0, amount=500_000 drops — within 70% LTV of 1M XRP collateral)
    log("\n=== 4. borrow (XRP, 500K drops) ===");
    results.borrow = await callFn(rpcUrl, client, wallet, contract, "borrow", networkId, "borrow");
    log(`→ ${results.borrow} ${results.borrow === "tesSUCCESS" ? "✅" : "❌"}`);

    // 5. repay (asset_id=0, amount=500_000 drops)
    log("\n=== 5. repay (XRP, 500K drops) ===");
    results.repay = await callFn(rpcUrl, client, wallet, contract, "repay", networkId, "repay");
    log(`→ ${results.repay} ${results.repay === "tesSUCCESS" ? "✅" : "❌"}`);

    // 6. withdraw_collateral (asset_id=0, amount=1_000_000 drops)
    log("\n=== 6. withdraw_collateral (XRP, 1M drops) ===");
    results.withdraw_collateral = await callFn(rpcUrl, client, wallet, contract, "withdraw_collateral", networkId, "withdraw_collateral");
    log(`→ ${results.withdraw_collateral} ${results.withdraw_collateral === "tesSUCCESS" ? "✅" : "❌"}`);

    // 7. withdraw (asset_id=0, shares=1_000_000)
    log("\n=== 7. withdraw (XRP, 1M shares) ===");
    results.withdraw = await callFn(rpcUrl, client, wallet, contract, "withdraw", networkId, "withdraw");
    log(`→ ${results.withdraw} ${results.withdraw === "tesSUCCESS" ? "✅" : "❌"}`);

  } finally {
    await client.disconnect();
  }

  // Summary
  log("\n═══════════════════════════════════════");
  log("SUMMARY");
  log("═══════════════════════════════════════");
  for (const [fn, result] of Object.entries(results)) {
    log(`  ${fn.padEnd(22)} ${result.padEnd(20)} ${result === "tesSUCCESS" ? "✅" : "❌"}`);
  }
  const passed = Object.values(results).filter(r => r === "tesSUCCESS").length;
  log(`\nPassed: ${passed}/${Object.keys(results).length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
