/**
 * deploy-vaults.ts
 *
 * Creates 3 single-asset Supply Vaults on XRPL AlphaNet using VaultSet (XLS-65).
 * Each vault is created as a public vault (tfVaultPublic = 0x00000001).
 *
 * After creation, the VaultID (ledger index) is saved to deployed.json.
 *
 * Usage:
 *   DEPLOYER_SECRET=sXXX RLUSD_ISSUER=rXXX WBTC_ISSUER=rXXX tsx deploy-vaults.ts
 */

import { Client, Wallet } from "xrpl";
import type { SubmittableTransaction, TxResponse } from "xrpl";
import {
  loadDeployEnv, loadDeployedState, saveDeployedState,
  extractCreatedNodeIndex, log, die,
} from "./shared.js";

// tfVaultPublic flag (XLS-65)
const TF_VAULT_PUBLIC = 0x00000001;

interface VaultAsset {
  currency: string;
  issuer?: string;
}

interface VaultSetTx {
  TransactionType: "VaultSet";
  Account: string;
  Asset: VaultAsset | { currency: "XRP" };
  Flags: number;
  Fee?: string;
}

async function createVault(
  client: Client,
  wallet: Wallet,
  asset: VaultAsset | { currency: "XRP" },
  label: string,
): Promise<string> {
  log(`Creating ${label} vault...`);

  const tx: VaultSetTx = {
    TransactionType: "VaultSet",
    Account: wallet.classicAddress,
    Asset: asset,
    Flags: TF_VAULT_PUBLIC,
  };

  const result = await client.submitAndWait(
    tx as unknown as SubmittableTransaction,
    { autofill: true, wallet },
  ) as TxResponse;

  const meta = result.result.meta as unknown as Record<string, unknown>;
  const engineResult = (meta?.TransactionResult as string) ?? "unknown";

  if (engineResult !== "tesSUCCESS") {
    die(`VaultSet for ${label} failed: ${engineResult}`);
  }

  const vaultId = extractCreatedNodeIndex(meta, "Vault");
  if (!vaultId) {
    die(`No Vault node found in metadata for ${label}`);
  }

  log(`${label} vault created`, { vaultId, hash: result.result.hash });
  return vaultId;
}

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const wallet = Wallet.fromSeed(env.deployerSecret);

  log("Connecting to XRPL...", { url: env.wsUrl, deployer: wallet.classicAddress });

  const client = new Client(env.wsUrl);
  await client.connect();

  try {
    // Create XRP vault
    const xrpVaultId = await createVault(
      client, wallet,
      { currency: "XRP" },
      "XRP",
    );

    // Create RLUSD vault
    if (!env.rlusdIssuer) die("RLUSD_ISSUER env var required for RLUSD vault");
    const rlusdVaultId = await createVault(
      client, wallet,
      { currency: "RLUSD", issuer: env.rlusdIssuer },
      "RLUSD",
    );

    // Create wBTC vault
    if (!env.wbtcIssuer) die("WBTC_ISSUER env var required for wBTC vault");
    const wbtcVaultId = await createVault(
      client, wallet,
      { currency: "wBTC", issuer: env.wbtcIssuer },
      "wBTC",
    );

    // Save to deployed.json
    const existing = loadDeployedState();
    saveDeployedState({
      network: env.wsUrl,
      deployer: wallet.classicAddress,
      timestamp: new Date().toISOString(),
      vaultIds: {
        XRP: xrpVaultId,
        RLUSD: rlusdVaultId,
        WBTC: wbtcVaultId,
      },
      controllerAddress: existing?.controllerAddress,
      vaultAccounts: existing?.vaultAccounts,
    });

    log("All vaults deployed successfully.");
  } finally {
    await client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
