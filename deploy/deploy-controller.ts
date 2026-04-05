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
import { fileURLToPath } from "url";
import { Client, Wallet } from "xrpl";
import type { SubmittableTransaction, TxResponse } from "xrpl";
import {
  loadDeployEnv, loadDeployedState, saveDeployedState,
  extractCreatedAccount, toUpperHex, log, die, WASM_PATH,
} from "./shared.js";
import { LendingClient } from "xrpl-lending-sdk";
import { globalKey, toHex } from "xrpl-lending-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = resolve(__dirname, "../contracts/lending-controller");

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

  const tx = {
    TransactionType: "ContractCreate",
    Account: wallet.classicAddress,
    WASMBytecode: wasmHex,
  };

  const result = await client.submitAndWait(
    tx as unknown as SubmittableTransaction,
    { autofill: true, wallet },
  ) as TxResponse;

  const meta = result.result.meta as unknown as Record<string, unknown>;
  const engineResult = (meta?.TransactionResult as string) ?? "unknown";

  if (engineResult !== "tesSUCCESS") {
    die(`ContractCreate failed: ${engineResult}`);
  }

  // Extract the contract pseudo-account from metadata
  const contractAddress = extractCreatedAccount(meta);
  if (!contractAddress) {
    die("No contract pseudo-account found in ContractCreate metadata");
  }

  log("Contract deployed", { contractAddress, hash: result.result.hash });
  return contractAddress;
}

// ── Register vault accounts ───────────────────────────────────────────────────

async function registerVaultAccount(
  lendingClient: LendingClient,
  vaultIndex: number,
  vaultAddress: string,
): Promise<void> {
  // vault address → 20-byte AccountID
  const accountId = LendingClient.addressToAccountId(vaultAddress);

  // state key: "vault{i}" (global_key = "glb:vault{i}")
  const key = globalKey(`vault${vaultIndex}`);

  // We need a special Invoke to write state — this is an admin-only set_vault function.
  // The contract exposes `set_vault(asset_id: u32, vault_ptr: u32)` for admin setup.
  // Args: u32LE(vaultIndex) + 20 bytes accountId = 24 bytes total
  const args = new Uint8Array(24);
  args[0] = vaultIndex & 0xff;
  args[1] = (vaultIndex >> 8) & 0xff;
  args[2] = (vaultIndex >> 16) & 0xff;
  args[3] = (vaultIndex >> 24) & 0xff;
  args.set(accountId, 4);

  log(`Registering vault ${vaultIndex} account: ${vaultAddress}`);
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
  const wallet = Wallet.fromSeed(env.deployerSecret);

  const existing = loadDeployedState();
  if (!existing) {
    die("No deployed.json found. Run deploy-vaults.ts first.");
  }

  if (!existing.vaultIds.XRP || !existing.vaultIds.RLUSD || !existing.vaultIds.WBTC) {
    die("All vault IDs must be set in deployed.json. Run deploy-vaults.ts first.");
  }

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

    // 4. Register vault accounts (vault ledger objects → AccountID stored in contract state)
    // We need the vault AccountIDs, not just the VaultIDs.
    // For now we store the deployer's address as vault owner — this needs to be
    // the actual vault r-address on AlphaNet (extracted from vault metadata).
    // The VaultID is the ledger index; the vault account is typically the creator's address.
    // Until vault account resolution is available, we record for manual completion.
    log("Note: Vault account registration requires resolving VaultID → AccountID.");
    log("Vault IDs saved. Set VAULT_XRP_ACCOUNT, VAULT_RLUSD_ACCOUNT, VAULT_WBTC_ACCOUNT env vars to register.");

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
      await registerVaultAccount(lendingClient, 0, vaultXrpAccount);
      await registerVaultAccount(lendingClient, 1, vaultRlusdAccount);
      await registerVaultAccount(lendingClient, 2, vaultWbtcAccount);
    } else {
      log("Skipping vault registration (VAULT_*_ACCOUNT env vars not set).");
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
