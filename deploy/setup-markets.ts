/**
 * setup-markets.ts
 *
 * One-shot market configuration script for XRPL Lending V1.
 *
 * Steps:
 *   1. Fund two "issuer" accounts (RLUSD issuer, wBTC issuer) via faucet
 *   2. Create 3 supply vaults (XRP, RLUSD, wBTC) via VaultSet (XLS-65)
 *   3. Extract vault pseudo-accounts from VaultSet metadata
 *   4. Register vault accounts in the deployed contract via set_vault
 *   5. Save all addresses and vault IDs to deployed.json
 *
 * Usage:
 *   DEPLOYER_SECRET=sXXX tsx setup-markets.ts
 *
 * Optional overrides:
 *   RLUSD_ISSUER=rXXX  — reuse existing RLUSD issuer
 *   WBTC_ISSUER=rXXX   — reuse existing wBTC issuer
 *   XRPL_WSS_URL=wss://... — override network (default: alphanet.nerdnest.xyz)
 */

import { Client, Wallet, decodeAccountID } from "xrpl";
import type { SubmittableTransaction, TxResponse } from "xrpl";
import { LendingClient } from "xrpl-lending-sdk";
import {
  loadDeployEnv, loadDeployedState, saveDeployedState,
  extractCreatedNodeIndex, log, die,
} from "./shared.js";

const FAUCET_URL = "https://alphanet.faucet.nerdnest.xyz/accounts";

// ── Faucet helper ─────────────────────────────────────────────────────────────

async function fundFromFaucet(wallet: Wallet): Promise<void> {
  log(`Funding ${wallet.classicAddress} from faucet...`);
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination: wallet.classicAddress }),
  });
  if (!res.ok) {
    const text = await res.text();
    die(`Faucet failed for ${wallet.classicAddress}: ${res.status} ${text}`);
  }
  log(`Funded ${wallet.classicAddress}`);
  // Wait 2s for ledger to close
  await new Promise(r => setTimeout(r, 2000));
}

// ── Vault creation ────────────────────────────────────────────────────────────

interface VaultAsset {
  currency: string;
  issuer?: string;
}

async function createVault(
  client: Client,
  wallet: Wallet,
  asset: VaultAsset | { currency: "XRP" },
  label: string,
): Promise<{ vaultId: string; vaultAccount: string }> {
  log(`Creating ${label} supply vault...`);

  const tx = {
    TransactionType: "VaultCreate",
    Account: wallet.classicAddress,
    Asset: asset,
    // No flags = public vault (tfVaultPrivate = 0x00010000 to make private)
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
    die(`No Vault ledger entry found in metadata for ${label}. Is XLS-65 enabled on this network?`);
  }

  // The vault pseudo-account is created as a new AccountRoot alongside the Vault entry
  const vaultAccount = extractVaultAccount(meta, wallet.classicAddress);
  if (!vaultAccount) {
    // Fallback: derive vault account from VaultID using the ledger convention
    log(`Warning: no vault AccountRoot found in metadata for ${label}. Logging full metadata for inspection.`);
    log(`Metadata: ${JSON.stringify(meta, null, 2)}`);
    die(`Cannot determine vault account for ${label}`);
  }

  log(`${label} vault created`, { vaultId, vaultAccount, hash: result.result.hash });
  return { vaultId, vaultAccount };
}

function extractVaultAccount(meta: unknown, excludeAddress: string): string | undefined {
  const m = meta as Record<string, unknown>;
  const nodes = (m?.AffectedNodes as unknown[]) ?? [];
  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    const created = n?.CreatedNode as Record<string, unknown> | undefined;
    if (created?.LedgerEntryType === "AccountRoot") {
      const nf = created?.NewFields as Record<string, unknown> | undefined;
      const account = nf?.Account as string | undefined;
      // Exclude the tx sender — we want the vault's pseudo-account
      if (account && account !== excludeAddress) return account;
    }
  }
  return undefined;
}

// ── set_vault call ────────────────────────────────────────────────────────────

async function registerVault(
  lendingClient: LendingClient,
  assetId: number,
  vaultAddress: string,
): Promise<void> {
  const accountId = decodeAccountID(vaultAddress);

  // Args: u32LE(assetId) + 20-byte AccountID = 24 bytes
  const args = new Uint8Array(24);
  args[0] = assetId & 0xff;
  args[1] = (assetId >> 8) & 0xff;
  args[2] = (assetId >> 16) & 0xff;
  args[3] = (assetId >> 24) & 0xff;
  args.set(accountId, 4);

  log(`Registering vault ${assetId} (${vaultAddress}) in contract...`);
  const result = await lendingClient.submitInvoke("set_vault", args);

  if (result.engineResult !== "tesSUCCESS") {
    log(`Warning: set_vault(${assetId}) = ${result.engineResult} (hash: ${result.hash})`);
  } else {
    log(`Vault ${assetId} registered`, { hash: result.hash });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const existing = loadDeployedState();

  if (!existing?.controllerAddress) {
    die("No controllerAddress in deployed.json. Deploy the contract first.");
  }

  const deployer = Wallet.fromSeed(env.deployerSecret);
  log("Setup markets", {
    deployer: deployer.classicAddress,
    controller: existing.controllerAddress,
    network: env.wsUrl,
  });

  const client = new Client(env.wsUrl);
  await client.connect();

  try {
    // 1. Ensure/create token issuers
    let rlusdIssuer = env.rlusdIssuer;
    let wbtcIssuer = env.wbtcIssuer;

    if (!rlusdIssuer) {
      const issuerWallet = Wallet.generate();
      await fundFromFaucet(issuerWallet);
      rlusdIssuer = issuerWallet.classicAddress;
      log(`RLUSD issuer created: ${rlusdIssuer} (seed: ${issuerWallet.seed})`);
    }
    if (!wbtcIssuer) {
      const issuerWallet = Wallet.generate();
      await fundFromFaucet(issuerWallet);
      wbtcIssuer = issuerWallet.classicAddress;
      log(`wBTC issuer created: ${wbtcIssuer} (seed: ${issuerWallet.seed})`);
    }

    // 2. Create supply vaults
    const xrp   = await createVault(client, deployer, { currency: "XRP" }, "XRP");
    const rlusd = await createVault(client, deployer, { currency: "RLUSD", issuer: rlusdIssuer }, "RLUSD");
    const wbtc  = await createVault(client, deployer, { currency: "wBTC",  issuer: wbtcIssuer  }, "wBTC");

    // 3. Register vault accounts in contract
    const lendingClient = new LendingClient({
      wsUrl: env.wsUrl,
      contractAddress: existing.controllerAddress,
      wallet: deployer,
    });
    // Reuse the existing connected client
    (lendingClient as unknown as { xrplClient: Client }).xrplClient = client;

    await registerVault(lendingClient, 0, xrp.vaultAccount);
    await registerVault(lendingClient, 1, rlusd.vaultAccount);
    await registerVault(lendingClient, 2, wbtc.vaultAccount);

    // 4. Persist state
    saveDeployedState({
      ...existing,
      network: env.wsUrl,
      deployer: deployer.classicAddress,
      timestamp: new Date().toISOString(),
      vaultIds: {
        XRP: xrp.vaultId,
        RLUSD: rlusd.vaultId,
        WBTC: wbtc.vaultId,
      },
      vaultAccounts: {
        XRP: xrp.vaultAccount,
        RLUSD: rlusd.vaultAccount,
        WBTC: wbtc.vaultAccount,
      },
      rlusdIssuer,
      wbtcIssuer,
    } as typeof existing & { rlusdIssuer: string; wbtcIssuer: string });

    log("Market setup complete. Summary:");
    log(`  Controller:    ${existing.controllerAddress}`);
    log(`  XRP vault:     ${xrp.vaultAccount}  (id: ${xrp.vaultId})`);
    log(`  RLUSD vault:   ${rlusd.vaultAccount}  (id: ${rlusd.vaultId})`);
    log(`  wBTC vault:    ${wbtc.vaultAccount}  (id: ${wbtc.vaultId})`);
    log(`  RLUSD issuer:  ${rlusdIssuer}`);
    log(`  wBTC issuer:   ${wbtcIssuer}`);

  } finally {
    await client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
