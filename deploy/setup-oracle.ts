/**
 * setup-oracle.ts
 *
 * Verifies DIA oracle accessibility on AlphaNet:
 *   - Connects to XRPL
 *   - Reads the DIA oracle ledger entry (XLS-47)
 *   - Parses and prints current prices for XRP, RLUSD, wBTC
 *   - Checks price freshness (must be < 300s old)
 *   - Verifies RLUSD price is within circuit-breaker bounds [0.95, 1.05]
 *   - Exits with code 1 if anything is misconfigured
 *
 * Usage:
 *   tsx setup-oracle.ts [--wsUrl wss://...]
 */

import { Client } from "xrpl";
import {
  LendingClient, getAllPrices, AssetIndex, ASSET_NAMES,
  DIA_ORACLE_ACCOUNT, DIA_DOCUMENT_ID, MAX_ORACLE_STALENESS,
  LendingError, LendingErrorCode, WAD,
} from "xrpl-lending-sdk";
import { loadDeployedState, log, die, ALPHANET_WSS } from "./shared.js";

function formatPrice(priceWad: bigint): string {
  const whole = priceWad / WAD;
  const frac = ((priceWad % WAD) * 1000n) / WAD;
  return `$${whole}.${frac.toString().padStart(3, "0")}`;
}

async function main(): Promise<void> {
  // Allow --wsUrl override
  const wsUrlArg = process.argv.indexOf("--wsUrl");
  const wsUrl = wsUrlArg >= 0 ? process.argv[wsUrlArg + 1] : (process.env.XRPL_WSS_URL ?? ALPHANET_WSS);

  const existing = loadDeployedState();
  const contractAddress = existing?.controllerAddress ?? "rDummyXXXXXXXXXXXXXXXXXXXXXXXXXXX";

  log("Connecting to XRPL...", { url: wsUrl });
  const xrplClient = new Client(wsUrl);
  await xrplClient.connect();

  const client = new LendingClient({ wsUrl, contractAddress });
  (client as unknown as { xrplClient: Client }).xrplClient = xrplClient;

  try {
    log("Reading DIA oracle...", {
      account: DIA_ORACLE_ACCOUNT,
      documentId: DIA_DOCUMENT_ID,
      maxStaleness: `${MAX_ORACLE_STALENESS}s`,
    });

    // Read raw oracle entry first (for diagnostics)
    let rawNode: Record<string, unknown>;
    try {
      rawNode = await client.readOracleLedgerEntry(DIA_ORACLE_ACCOUNT, DIA_DOCUMENT_ID);
    } catch (err) {
      if (err instanceof LendingError && err.code === LendingErrorCode.OracleNotConfigured) {
        die("Oracle not configured on this network. DIA oracle ledger entry not found.");
      }
      throw err;
    }

    const lastUpdateTime = (rawNode.LastUpdateTime as number) ?? 0;
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = now - lastUpdateTime;

    log("Oracle entry found", {
      lastUpdateTime: new Date(lastUpdateTime * 1000).toISOString(),
      ageSeconds,
      maxAge: MAX_ORACLE_STALENESS,
      isStale: ageSeconds > MAX_ORACLE_STALENESS,
    });

    // Parse all prices
    let prices: Awaited<ReturnType<typeof getAllPrices>>;
    try {
      prices = await getAllPrices(client);
    } catch (err) {
      if (err instanceof LendingError) {
        switch (err.code) {
          case LendingErrorCode.OracleStale:
            die(`Oracle is STALE (last update ${ageSeconds}s ago, max ${MAX_ORACLE_STALENESS}s)`);
          case LendingErrorCode.OracleCircuitBreaker:
            die(`RLUSD circuit breaker triggered: ${err.message}`);
          case LendingErrorCode.OraclePriceZero:
            die(`Oracle has missing price entries: ${err.message}`);
          default:
            die(`Oracle error ${err.code}: ${err.message}`);
        }
      }
      throw err;
    }

    console.log("\n── Oracle Prices ──────────────────────────────────────────");
    for (const p of prices) {
      const name = ASSET_NAMES[p.assetIndex];
      const price = formatPrice(p.priceWad);
      const note = p.assetIndex === AssetIndex.RLUSD ? " (pegged, circuit breaker active)" : "";
      console.log(`  ${name.padEnd(8)} ${price.padStart(14)}${note}`);
    }
    console.log("──────────────────────────────────────────────────────────\n");

    log("Oracle verification PASSED.", {
      ageSeconds,
      assetsVerified: prices.length,
    });
  } finally {
    await xrplClient.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
