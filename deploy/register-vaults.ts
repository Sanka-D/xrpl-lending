/**
 * register-vaults.ts
 *
 * Calls set_vault on the deployed lending controller to register vault accounts.
 * Use this when XLS-65 (VaultCreate) is not available on the network and you want
 * to initialize the contract with placeholder vault addresses.
 *
 * Pass vault addresses via env vars:
 *   VAULT_XRP=rXXX VAULT_RLUSD=rXXX VAULT_WBTC=rXXX DEPLOYER_SECRET=sXXX tsx register-vaults.ts
 *
 * If vault addresses are omitted, defaults to the deployer's own address (for local dev).
 */

import { Client, Wallet } from "xrpl";
import { LendingClient } from "xrpl-lending-sdk";
import { loadDeployEnv, loadDeployedState, saveDeployedState, log, die } from "./shared.js";

async function registerVault(
  lendingClient: LendingClient,
  assetId: number,
  label: string,
): Promise<void> {
  // set_vault(asset_id: u32) — caller becomes the vault account (write-once)
  const args = new Uint8Array(4);
  args[0] = assetId & 0xff;
  args[1] = (assetId >> 8) & 0xff;
  args[2] = (assetId >> 16) & 0xff;
  args[3] = (assetId >> 24) & 0xff;

  log(`Registering ${label} vault (caller = vault account)`);
  const result = await lendingClient.submitInvoke("set_vault", args);

  if (result.engineResult !== "tesSUCCESS") {
    log(`Warning: set_vault(${assetId}/${label}) = ${result.engineResult}`);
  } else {
    log(`${label} vault registered ✓`, { hash: result.hash });
  }
}

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const state = loadDeployedState();

  if (!state?.controllerAddress) {
    die("No controllerAddress in deployed.json. Deploy the contract first.");
  }

  const deployer = Wallet.fromSeed(env.deployerSecret);

  log("Registering vaults", {
    controller: state.controllerAddress,
    deployer: deployer.classicAddress,
  });
  log("NOTE: Vault account = caller (deployer). Real vaults require XLS-65 (Vault) amendment.");

  const client = new Client(env.wsUrl);
  await client.connect();

  const lendingClient = new LendingClient({
    wsUrl: env.wsUrl,
    contractAddress: state.controllerAddress,
    wallet: deployer,
  });
  (lendingClient as unknown as { xrplClient: Client }).xrplClient = client;

  const deployer_address = deployer.classicAddress;

  try {
    await registerVault(lendingClient, 0, "XRP");
    await registerVault(lendingClient, 1, "RLUSD");
    await registerVault(lendingClient, 2, "wBTC");

    saveDeployedState({
      ...state,
      vaultAccounts: {
        XRP: deployer_address,
        RLUSD: deployer_address,
        WBTC: deployer_address,
      },
    });

    log("Vault registration complete.");
  } finally {
    await client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
