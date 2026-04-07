/**
 * fund-test-wallets.ts
 *
 * Generates two fresh wallets (Alice + Bob) and funds each with 2000 XRP
 * from the genesis account (100B XRP on local Bedrock node).
 *
 * Usage:
 *   tsx fund-test-wallets.ts
 *
 * Output: ALICE_SECRET=sXxx BOB_SECRET=sXxx ready to paste into smoke-test.ts
 */

import { Client, Wallet } from "xrpl";
import type { Payment } from "xrpl";
import { loadDeployEnv, loadDeployWallet, log, die } from "./shared.js";

const FUND_AMOUNT_XRP = 2000;
const FUND_DROPS = String(FUND_AMOUNT_XRP * 1_000_000);

async function fundWallet(
  client: Client,
  funder: Wallet,
  target: Wallet,
  label: string,
): Promise<void> {
  log(`Funding ${label} (${target.classicAddress}) with ${FUND_AMOUNT_XRP} XRP...`);

  const tx: Payment = {
    TransactionType: "Payment",
    Account: funder.classicAddress,
    Destination: target.classicAddress,
    Amount: FUND_DROPS,
  };

  const result = await client.submitAndWait(tx, { autofill: true, wallet: funder });
  const meta = result.result.meta as unknown as Record<string, unknown>;
  const engineResult = (meta?.TransactionResult as string) ?? "unknown";

  if (engineResult !== "tesSUCCESS") {
    die(`Funding ${label} failed: ${engineResult}`);
  }

  log(`${label} funded`, { hash: result.result.hash, address: target.classicAddress });
}

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const genesis = loadDeployWallet(env.deployerSecret);

  log("Connecting...", { url: env.wsUrl, funder: genesis.classicAddress });

  const client = new Client(env.wsUrl);
  await client.connect();

  try {
    const alice = Wallet.generate();
    const bob   = Wallet.generate();

    await fundWallet(client, genesis, alice, "Alice");
    await fundWallet(client, genesis, bob, "Bob");

    console.log("\n════════════════════════════════════════════════");
    console.log(" Test wallets ready — copy for smoke-test:");
    console.log("════════════════════════════════════════════════");
    console.log(` Alice address: ${alice.classicAddress}`);
    console.log(` Alice seed:    ${alice.seed}`);
    console.log(` Bob   address: ${bob.classicAddress}`);
    console.log(` Bob   seed:    ${bob.seed}`);
    console.log("\n Run smoke test:");
    console.log(` ALICE_SECRET=${alice.seed} BOB_SECRET=${bob.seed} npx tsx smoke-test.ts`);
    console.log("════════════════════════════════════════════════\n");

  } finally {
    await client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
