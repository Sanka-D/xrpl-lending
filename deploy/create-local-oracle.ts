/**
 * create-local-oracle.ts
 *
 * Creates an XLS-47 OracleSet entry on the local Bedrock node using the genesis account.
 * The contract's DIA_ORACLE_ACCOUNT constant must be compiled with the genesis account
 * bytes (state.rs) for this to be read by the lending controller.
 *
 * Prices (for local testing):
 *   XRP   = $2.15   → AssetPrice=215000000, Scale=8
 *   RLUSD = $1.00   → AssetPrice=100000000, Scale=8
 *   BTC   = $84,000 → AssetPrice=8400000000000, Scale=8
 *
 * Usage:
 *   tsx create-local-oracle.ts
 */

import { Client, Wallet } from "xrpl";
import type { SubmittableTransaction } from "xrpl";
import { loadDeployEnv, loadDeployWallet, log, die } from "./shared.js";

// XLS-47 OracleSet: LastUpdateTime uses Unix epoch (not Ripple epoch).
// Non-standard currency codes (>3 chars) must be 20-byte hex (right-padded with zeros).
function toOracleCurrency(ticker: string): string {
  // XRP and 3-letter codes are passed as-is; longer codes need 20-byte hex encoding
  if (ticker === "XRP" || ticker.length <= 3) return ticker;
  const hex = Buffer.from(ticker).toString("hex").padEnd(40, "0").toUpperCase();
  return hex;
}

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const wallet = loadDeployWallet(env.deployerSecret);

  log("Creating local oracle...", { account: wallet.classicAddress, url: env.wsUrl });

  const client = new Client(env.wsUrl);
  await client.connect();

  try {
    // LastUpdateTime = current Unix timestamp (XLS-47 uses Unix epoch, not Ripple epoch)
    const lastUpdateTime = Math.floor(Date.now() / 1000);

    const tx = {
      TransactionType: "OracleSet",
      Account: wallet.classicAddress,
      OracleDocumentID: 42,
      // Provider and AssetClass are required hex strings (arbitrary for local)
      Provider: Buffer.from("LOCAL").toString("hex").toUpperCase(),
      AssetClass: Buffer.from("currency").toString("hex").toUpperCase(),
      LastUpdateTime: lastUpdateTime,
      PriceDataSeries: [
        {
          PriceData: {
            BaseAsset: "XRP",
            QuoteAsset: "USD",
            AssetPrice: "215000000",  // $2.15 (scale=8 → ×10^-8)
            Scale: 8,
          },
        },
        {
          PriceData: {
            BaseAsset: toOracleCurrency("RLUSD"),
            QuoteAsset: "USD",
            AssetPrice: "100000000",  // $1.00
            Scale: 8,
          },
        },
        {
          PriceData: {
            BaseAsset: toOracleCurrency("BTC"),
            QuoteAsset: "USD",
            AssetPrice: "8400000000000",  // $84,000
            Scale: 8,
          },
        },
      ],
    };

    const result = await client.submitAndWait(
      tx as unknown as SubmittableTransaction,
      { autofill: true, wallet },
    );

    const meta = result.result.meta as unknown as Record<string, unknown>;
    const engineResult = (meta?.TransactionResult as string) ?? "unknown";

    if (engineResult !== "tesSUCCESS") {
      die(`OracleSet failed: ${engineResult} — tx: ${result.result.hash}`);
    }

    log("Oracle created successfully", { hash: result.result.hash });
    log("Prices set:", {
      "XRP/USD": "$2.15",
      "RLUSD/USD": "$1.00",
      "BTC/USD": "$84,000",
    });

    // Verify the oracle is readable
    try {
      const entry = await client.request({
        command: "ledger_entry",
        oracle: {
          account: wallet.classicAddress,
          oracle_document_id: 42,
        },
      } as Parameters<typeof client.request>[0]);
      log("Oracle ledger entry verified", { index: (entry.result as Record<string, unknown>).index });
    } catch (e) {
      log("Warning: could not verify oracle ledger entry", { error: String(e) });
    }

  } finally {
    await client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
