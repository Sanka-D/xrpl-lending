/**
 * configure-markets.ts
 *
 * Sends ContractCall Invoke transactions to set risk parameters for each V1 market
 * and configure the DIA oracle source per asset.
 *
 * Note: The Rust contract has V1 market configs hardcoded as compile-time constants.
 * This script is useful for:
 *   - Override/update configurations after deployment
 *   - Verifying the deployed contract responds correctly to admin calls
 *   - Testing the `set_market_config` / `set_oracle_config` entry points
 *
 * Usage:
 *   DEPLOYER_SECRET=sXXX tsx configure-markets.ts
 */

import { Client, Wallet, decodeAccountID } from "xrpl";
import {
  LendingClient, AssetIndex, V1_MARKETS, DIA_ORACLE_ACCOUNT, DIA_DOCUMENT_ID,
  ASSET_TICKERS,
} from "xrpl-lending-sdk";
import { loadDeployEnv, loadDeployedState, loadDeployWallet, log, die } from "./shared.js";

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encodeU64LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let rem = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return buf;
}

function encodeU32LE(v: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = v & 0xff;
  buf[1] = (v >> 8) & 0xff;
  buf[2] = (v >> 16) & 0xff;
  buf[3] = (v >> 24) & 0xff;
  return buf;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ── Market config args encoding ───────────────────────────────────────────────
// set_market_config(
//   asset_id: u32,           4 bytes
//   ltv: u64,                8 bytes
//   liq_threshold: u64,      8 bytes
//   liq_bonus: u64,          8 bytes
//   reserve_factor: u64,     8 bytes
//   max_liq_bps: u64,        8 bytes
//   optimal_util: u64,       8 bytes
//   base_rate: u64,          8 bytes
//   slope1: u64,             8 bytes
//   slope2: u64,             8 bytes
//   borrow_enabled: u8,      1 byte
//   collateral_enabled: u8   1 byte
// ) = 77 bytes total

function encodeMarketConfig(asset: AssetIndex): Uint8Array {
  const cfg = V1_MARKETS[asset];
  return concat(
    encodeU32LE(asset),
    encodeU64LE(BigInt(cfg.ltv)),
    encodeU64LE(BigInt(cfg.liquidationThreshold)),
    encodeU64LE(BigInt(cfg.liquidationBonus)),
    encodeU64LE(BigInt(cfg.reserveFactor)),
    encodeU64LE(BigInt(cfg.maxLiquidationBps)),
    encodeU64LE(BigInt(cfg.optimalUtilization)),
    encodeU64LE(BigInt(cfg.baseRate)),
    encodeU64LE(BigInt(cfg.slope1)),
    encodeU64LE(BigInt(cfg.slope2)),
    new Uint8Array([cfg.borrowEnabled ? 1 : 0]),
    new Uint8Array([cfg.collateralEnabled ? 1 : 0]),
  );
}

// ── Oracle config args encoding ───────────────────────────────────────────────
// set_oracle_config(
//   asset_id: u32,           4 bytes
//   dia_account: [u8; 20],  20 bytes
//   doc_id: u32,             4 bytes
//   max_staleness: u64,      8 bytes
//   ticker_hex: [u8; 20],   20 bytes (ticker padded to 20 bytes)
// ) = 56 bytes

function encodeTicker(ticker: string): Uint8Array {
  const buf = new Uint8Array(20);
  const encoded = new TextEncoder().encode(ticker);
  buf.set(encoded.slice(0, 20));
  return buf;
}

function encodeOracleConfig(asset: AssetIndex): Uint8Array {
  const diaAccountId = decodeAccountID(DIA_ORACLE_ACCOUNT);
  const ticker = encodeTicker(ASSET_TICKERS[asset]);

  return concat(
    encodeU32LE(asset),
    diaAccountId,                       // 20 bytes
    encodeU32LE(DIA_DOCUMENT_ID),
    encodeU64LE(300n),                  // max staleness: 300s
    ticker,                             // 20 bytes
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadDeployEnv();
  const existing = loadDeployedState();

  if (!existing?.controllerAddress) {
    die("No controllerAddress in deployed.json. Run deploy-controller.ts first.");
  }

  const wallet = loadDeployWallet(env.deployerSecret);
  log("Configuring markets...", {
    controller: existing.controllerAddress,
    deployer: wallet.classicAddress,
  });

  const xrplClient = new Client(env.wsUrl);
  await xrplClient.connect();

  const client = new LendingClient({
    wsUrl: env.wsUrl,
    contractAddress: existing.controllerAddress,
    wallet,
  });
  // Reuse the already-connected client (cast to bypass readonly)
  (client as unknown as { xrplClient: Client }).xrplClient = xrplClient;

  try {
    const assets = [AssetIndex.XRP, AssetIndex.RLUSD, AssetIndex.WBTC] as const;
    const assetNames = ["XRP", "RLUSD", "wBTC"] as const;

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const name = assetNames[i];

      // Set market risk parameters
      log(`Setting market config for ${name}...`);
      const marketArgs = encodeMarketConfig(asset);
      const marketResult = await client.submitInvoke("set_market_config", marketArgs);
      if (marketResult.engineResult !== "tesSUCCESS") {
        log(`Warning: set_market_config(${name}) = ${marketResult.engineResult}`);
      } else {
        log(`Market config set for ${name}`, { hash: marketResult.hash });
      }

      // Set oracle config
      log(`Setting oracle config for ${name}...`);
      const oracleArgs = encodeOracleConfig(asset);
      const oracleResult = await client.submitInvoke("set_oracle_config", oracleArgs);
      if (oracleResult.engineResult !== "tesSUCCESS") {
        log(`Warning: set_oracle_config(${name}) = ${oracleResult.engineResult}`);
      } else {
        log(`Oracle config set for ${name}`, { hash: oracleResult.hash });
      }
    }

    log("All markets configured.");
  } finally {
    await xrplClient.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
