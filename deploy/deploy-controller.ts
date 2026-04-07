/**
 * deploy-controller.ts
 *
 * 1. Compiles the Rust lending controller to WASM (cargo build).
 * 2. Submits a ContractCreate transaction (XLS-101) with the WASM bytecode.
 * 3. Extracts the contract pseudo-account address from transaction metadata.
 * 4. Registers vault accounts in contract global state via Invoke.
 * 5. Saves the controller address to deployed.json.
 *
 * Usage:
 *   DEPLOYER_SECRET=sXXX tsx deploy-controller.ts
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import { Client, Wallet } from "xrpl";
import {
  loadDeployEnv, loadDeployedState, loadDeployWallet, saveDeployedState,
  extractCreatedAccount, toUpperHex, log, die, WASM_PATH,
} from "./shared.js";
import { LendingClient } from "xrpl-lending-sdk";
import { globalKey, toHex } from "xrpl-lending-sdk";

// @transia/xrpl is a fork of xrpl.js that knows ContractCreate (XLS-101) binary encoding.
// Use createRequire because deploy/ is an ESM package but @transia/xrpl is CJS.
const _require = createRequire(import.meta.url);
const transiaXrpl = _require("xrpl-lending-sdk/node_modules/@transia/xrpl") as {
  Wallet: typeof Wallet;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = resolve(__dirname, "../contracts/lending-controller");

// WASM-exported function names (hex-encoded) registered in ContractCreate.Functions ABI.
// Max 8 functions per ContractCreate (temARRAY_TOO_LARGE otherwise).
// View functions (get_health_factor, get_user_position) are callable without ABI registration.
const CONTRACT_FUNCTIONS = [
  "set_vault", "supply", "deposit_collateral", "borrow", "repay",
  "withdraw", "withdraw_collateral", "liquidate",
].map(name => ({ Function: { FunctionName: Buffer.from(name).toString("hex").toUpperCase() } }));

// ── Build WASM ────────────────────────────────────────────────────────────────

function buildWasm(): void {
  log("Building WASM...");
  try {
    execSync("cargo build --target wasm32-unknown-unknown --release", {
      cwd: CONTRACT_DIR,
      stdio: "inherit",
    });
    log("WASM build succeeded.");
  } catch (err) {
    die(`cargo build failed: ${err}`);
  }
}

// ── Deploy contract ───────────────────────────────────────────────────────────

async function deployContract(
  client: Client,
  wallet: Wallet,
  wasmHex: string,
): Promise<string> {
  log("Submitting ContractCreate transaction...", { wasmBytes: wasmHex.length / 2 });

  const wsUrl = (client as unknown as { connection: { url: string } }).connection?.url
    ?? "ws://localhost:6006";
  const rpcUrl = wsUrl.replace("wss://", "https://").replace("ws://", "http://")
    .replace(":6006", ":5005").replace(":51233", ":51234");

  // Autofill sequence + networkId via HTTP RPC
  const acctRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: wallet.classicAddress, ledger_index: "current" }],
    }),
  });
  const acctJson = await acctRes.json() as Record<string, unknown>;
  const acctData = ((acctJson.result as Record<string, unknown>).account_data as Record<string, unknown>);

  const serverRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "server_info", params: [{}] }),
  });
  const serverJson = await serverRes.json() as Record<string, unknown>;
  const networkId = ((serverJson.result as Record<string, unknown>).info as Record<string, unknown>)?.network_id as number ?? 0;

  const tx: Record<string, unknown> = {
    TransactionType: "ContractCreate",
    Account: wallet.classicAddress,
    ContractCode: wasmHex,
    Functions: CONTRACT_FUNCTIONS,
    Fee: "1000000",
    Sequence: acctData.Sequence as number,
    SigningPubKey: wallet.publicKey,
    Flags: 0,
  };
  if (networkId > 0) tx.NetworkID = networkId;

  // Sign using @transia/xrpl (knows ContractCreate binary encoding)
  const transiaWallet = new transiaXrpl.Wallet(wallet.publicKey, (wallet as unknown as { privateKey: string }).privateKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = (transiaWallet as any).sign(tx) as { tx_blob: string; hash: string };

  log("Signed ContractCreate, submitting...", { hash: signed.hash });

  const submitRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "submit", params: [{ tx_blob: signed.tx_blob }] }),
  });
  const submitJson = await submitRes.json() as Record<string, unknown>;
  const submitResult = submitJson.result as Record<string, unknown>;
  const engineResult = submitResult.engine_result as string ?? "unknown";

  if (engineResult !== "tesSUCCESS" && !engineResult.startsWith("ter")) {
    die(`ContractCreate submit failed: ${engineResult} — ${JSON.stringify(submitResult.engine_result_message ?? "")}`);
  }

  // Poll for validation (up to 30 ledgers)
  let hash = signed.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const txRes = await client.request({
        command: "tx",
        transaction: hash,
      } as Parameters<typeof client.request>[0]);
      const r = (txRes as unknown as Record<string, unknown>).result as Record<string, unknown>;
      if (r.validated) {
        const meta = r.meta as Record<string, unknown>;
        const finalResult = (meta?.TransactionResult as string) ?? "unknown";
        if (finalResult !== "tesSUCCESS") {
          die(`ContractCreate failed on-chain: ${finalResult}`);
        }
        // Extract the contract pseudo-account from metadata
        const contractAddress = extractCreatedAccount(meta);
        if (!contractAddress) {
          // Dump metadata to help debug
          log("ContractCreate metadata (no AccountRoot found):", meta);
          die("No contract pseudo-account found in ContractCreate metadata");
        }
        log("Contract deployed", { contractAddress, hash });
        return contractAddress;
      }
    } catch { /* not yet validated */ }
  }

  die(`ContractCreate not validated after 30s (hash: ${hash})`);
}

// ── Register vault accounts ───────────────────────────────────────────────────

async function registerVaultAccount(
  lendingClient: LendingClient,
  vaultIndex: number,
): Promise<void> {
  // set_vault(asset_id: u32) — caller becomes the vault account (write-once)
  const args = new Uint8Array(4);
  args[0] = vaultIndex & 0xff;
  args[1] = (vaultIndex >> 8) & 0xff;
  args[2] = (vaultIndex >> 16) & 0xff;
  args[3] = (vaultIndex >> 24) & 0xff;

  log(`Registering vault ${vaultIndex} (caller = vault account)`);
  const txResult = await lendingClient.submitInvoke("set_vault", args);

  if (txResult.engineResult !== "tesSUCCESS") {
    log(`Warning: set_vault(${vaultIndex}) returned ${txResult.engineResult}`);
  } else {
    log(`Vault ${vaultIndex} registered`, { hash: txResult.hash });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const wallet = loadDeployWallet(env.deployerSecret);

  const existing = loadDeployedState() ?? {
    network: env.wsUrl,
    deployer: wallet.classicAddress,
    timestamp: new Date().toISOString(),
    vaultIds: {},
  };

  // 1. Build WASM
  buildWasm();

  // 2. Read WASM binary
  log("Reading WASM binary...", { path: WASM_PATH });
  const wasmBytes = readFileSync(WASM_PATH);
  const wasmHex = toUpperHex(new Uint8Array(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength));
  log(`WASM size: ${wasmBytes.length} bytes (${wasmHex.length / 2} = same)`);

  const xrplClient = new Client(env.wsUrl);
  await xrplClient.connect();

  try {
    // 3. Deploy contract
    const contractAddress = await deployContract(xrplClient, wallet, wasmHex);

    // 4. Register vault accounts in contract state (glb:vault0/1/2 ← AccountID).
    // Vault accounts are r-addresses extracted from VaultCreate metadata by setup-markets.ts.
    // The preferred full deploy flow is: deploy-controller.ts → setup-markets.ts
    // (setup-markets creates the vaults AND calls set_vault in one pass).
    //
    // This script supports standalone vault registration if you already have vault r-addresses
    // from a prior run of setup-markets.ts: set VAULT_XRP_ACCOUNT, VAULT_RLUSD_ACCOUNT,
    // VAULT_WBTC_ACCOUNT and re-run deploy-controller.ts.

    const vaultXrpAccount = process.env.VAULT_XRP_ACCOUNT;
    const vaultRlusdAccount = process.env.VAULT_RLUSD_ACCOUNT;
    const vaultWbtcAccount = process.env.VAULT_WBTC_ACCOUNT;

    const lendingClient = new LendingClient({
      wsUrl: env.wsUrl,
      contractAddress,
      wallet,
    });
    (lendingClient as unknown as { xrplClient: Client }).xrplClient = xrplClient; // reuse existing connection

    if (vaultXrpAccount && vaultRlusdAccount && vaultWbtcAccount) {
      await registerVaultAccount(lendingClient, 0);
      await registerVaultAccount(lendingClient, 1);
      await registerVaultAccount(lendingClient, 2);
    } else {
      log("Vault accounts not provided — skipping registration. Run setup-markets.ts next to create vaults and register them.");
    }

    // 5. Save state
    saveDeployedState({
      ...existing,
      network: env.wsUrl,
      deployer: wallet.classicAddress,
      timestamp: new Date().toISOString(),
      controllerAddress: contractAddress,
      vaultAccounts: vaultXrpAccount ? {
        XRP: vaultXrpAccount,
        RLUSD: vaultRlusdAccount,
        WBTC: vaultWbtcAccount,
      } : existing.vaultAccounts,
    });

    log("Controller deployment complete.");
  } finally {
    await xrplClient.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
