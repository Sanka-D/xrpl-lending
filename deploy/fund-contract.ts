/**
 * fund-contract.ts
 *
 * Sends XRP from the genesis deployer to the contract's pseudo-account
 * so that set_data_object_field can create ContractData ledger entries
 * (which require the contract to have sufficient reserve balance).
 *
 * Usage:
 *   npx tsx fund-contract.ts
 */

import { Client, Wallet } from "xrpl";
import { loadDeployEnv, loadDeployWallet, loadDeployedState, log, die } from "./shared.js";

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const wallet = loadDeployWallet(env.deployerSecret);
  const state = loadDeployedState();

  if (!state?.controllerAddress) {
    die("No deployed.json with controllerAddress. Run deploy-controller.ts first.");
  }

  const contractAddress = state.controllerAddress;
  const wsUrl = env.wsUrl;
  const rpcUrl = wsUrl.replace("ws://", "http://").replace(":6006", ":5005");

  log(`Funding contract ${contractAddress} from ${wallet.classicAddress}`);

  // Get network ID
  const siRes = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "server_info", params: [{}] }),
  });
  const siJson = await siRes.json() as Record<string, unknown>;
  const networkId = ((siJson.result as Record<string, unknown>).info as Record<string, unknown>)?.network_id as number ?? 0;
  log(`NetworkID: ${networkId}`);

  // Check contract's current balance
  const acctRes = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "account_info", params: [{ account: contractAddress, ledger_index: "current" }] }),
  });
  const acctJson = await acctRes.json() as Record<string, unknown>;
  const acctResult = acctJson.result as Record<string, unknown>;
  if ((acctResult as Record<string, unknown>).account_data) {
    const bal = ((acctResult.account_data as Record<string, unknown>).Balance as string);
    log(`Contract current balance: ${bal} drops (${parseInt(bal) / 1_000_000} XRP)`);
  } else {
    log(`Contract account not found or balance unknown`);
  }

  // Get deployer sequence
  const depRes = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "account_info", params: [{ account: wallet.classicAddress, ledger_index: "current" }] }),
  });
  const depJson = await depRes.json() as Record<string, unknown>;
  const depData = ((depJson.result as Record<string, unknown>).account_data as Record<string, unknown>);
  const seq = depData.Sequence as number;
  log(`Deployer sequence: ${seq}`);

  // Build Payment transaction — 10 XRP to fund the contract
  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: contractAddress,
    Amount: "1200000", // 1.2 XRP = base_reserve(1M) + owner_reserve(200K) for OwnerCount=1
    // depositAuth exception: account below minimum reserve can receive up to minimum reserve
    Fee: "12",
    Sequence: seq,
    SigningPubKey: wallet.publicKey,
    Flags: 0,
  };
  if (networkId > 0) tx.NetworkID = networkId;

  const client = new Client(wsUrl);
  await client.connect();

  try {
    const signed = wallet.sign(tx as Parameters<typeof wallet.sign>[0]);
    log(`Signed payment, hash: ${signed.hash}`);

    const submitRes = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "submit", params: [{ tx_blob: signed.tx_blob }] }),
    });
    const submitJson = await submitRes.json() as Record<string, unknown>;
    const submitResult = submitJson.result as Record<string, unknown>;
    const engineResult = submitResult.engine_result as string ?? "unknown";
    log(`Submit result: ${engineResult}`);

    if (engineResult !== "tesSUCCESS" && !engineResult.startsWith("ter")) {
      die(`Payment failed: ${engineResult} — ${JSON.stringify(submitResult.engine_result_message ?? "")}`);
    }

    // Wait for validation
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const txRes = await client.request({ command: "tx", transaction: signed.hash } as Parameters<typeof client.request>[0]);
        const r = (txRes as unknown as Record<string, unknown>).result as Record<string, unknown>;
        if (r.validated) {
          const meta = r.meta as Record<string, unknown>;
          const finalResult = (meta?.TransactionResult as string) ?? "unknown";
          log(`Payment validated: ${finalResult}`);
          if (finalResult !== "tesSUCCESS") {
            die(`Payment failed on-chain: ${finalResult}`);
          }
          break;
        }
      } catch { /* not yet */ }
    }

    // Verify new balance
    await new Promise(r => setTimeout(r, 1000));
    const newRes = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "account_info", params: [{ account: contractAddress, ledger_index: "current" }] }),
    });
    const newJson = await newRes.json() as Record<string, unknown>;
    const newAcct = ((newJson.result as Record<string, unknown>).account_data as Record<string, unknown>);
    if (newAcct) {
      const newBal = newAcct.Balance as string;
      log(`Contract new balance: ${newBal} drops (${parseInt(newBal) / 1_000_000} XRP) ✅`);
    }

  } finally {
    await client.disconnect();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
