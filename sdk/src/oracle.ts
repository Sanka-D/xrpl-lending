/**
 * DIA oracle price reads via XLS-47 ledger_entry.
 *
 * DIA configuration mirrors Rust oracle.rs / state.rs constants.
 */

import { WAD, AssetIndex, LendingError, LendingErrorCode } from "./types";
import type { OraclePrice } from "./types";
import type { LendingClient } from "./client";

// ── DIA oracle constants (mirrors Rust state.rs) ────────────────────────────

export const DIA_ORACLE_ACCOUNT = "rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7";
export const DIA_DOCUMENT_ID = 42;
export const MAX_ORACLE_STALENESS = 300; // seconds

/** DIA ticker strings per asset (note: wBTC uses "BTC"). */
export const ASSET_TICKERS: Record<AssetIndex, string> = {
  [AssetIndex.XRP]: "XRP",
  [AssetIndex.RLUSD]: "RLUSD",
  [AssetIndex.WBTC]: "BTC",
};

// RLUSD circuit breaker bounds (WAD-scaled)
const RLUSD_CB_LOW = (WAD * 95n) / 100n;   // $0.95
const RLUSD_CB_HIGH = (WAD * 105n) / 100n; // $1.05

// ── Conversion ────────────────────────────────────────────────────────────────

/**
 * Convert DIA raw price to WAD-scaled USD.
 *
 *   price_wad = assetPrice × 10^(18 + scale)
 *
 * DIA typically uses scale = -8, so: assetPrice × 10^10.
 */
export function rawToWad(assetPrice: bigint, scale: number): bigint {
  const exponent = 18 + scale;
  if (exponent >= 0) {
    return assetPrice * 10n ** BigInt(exponent);
  } else {
    // exponent negative: divide
    return assetPrice / 10n ** BigInt(-exponent);
  }
}

/**
 * Apply RLUSD circuit breaker logic.
 *
 * If the DIA-reported price is within [0.95, 1.05] USD, return exactly 1.0 WAD
 * (the peg assumption). If outside that range, throw OracleCircuitBreaker.
 */
export function applyRlusdCircuitBreaker(priceWad: bigint): bigint {
  if (priceWad >= RLUSD_CB_LOW && priceWad <= RLUSD_CB_HIGH) {
    return WAD;
  }
  throw new LendingError(
    LendingErrorCode.OracleCircuitBreaker,
    `RLUSD price ${priceWad} outside circuit breaker bounds [${RLUSD_CB_LOW}, ${RLUSD_CB_HIGH}]`,
  );
}

// ── PriceDataSeries parsing ───────────────────────────────────────────────────

interface RawPriceEntry {
  PriceData: {
    BaseAsset: string;
    QuoteAsset: string;
    AssetPrice?: string; // u64 as string
    Scale?: number;
  };
}

function parsePriceDataSeries(
  series: unknown[],
  ticker: string,
): { assetPrice: bigint; scale: number } | null {
  for (const entry of series) {
    const e = entry as RawPriceEntry;
    if (e?.PriceData?.BaseAsset === ticker && e?.PriceData?.AssetPrice != null) {
      return {
        assetPrice: BigInt(e.PriceData.AssetPrice),
        scale: e.PriceData.Scale ?? -8,
      };
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the current price for a single asset from the DIA oracle.
 *
 * Validates staleness (must be < 300s old) and applies the RLUSD circuit breaker.
 *
 * @throws LendingError(OracleStale) if the price is too old
 * @throws LendingError(OraclePriceZero) if the asset has no price entry
 * @throws LendingError(OracleCircuitBreaker) if RLUSD price is out of peg range
 */
export async function getPrice(
  client: LendingClient,
  asset: AssetIndex,
): Promise<OraclePrice> {
  const prices = await getAllPrices(client);
  const found = prices.find(p => p.assetIndex === asset);
  if (!found) {
    throw new LendingError(LendingErrorCode.OracleNotConfigured, `No price for asset ${asset}`);
  }
  return found;
}

/**
 * Read all V1 asset prices from the DIA oracle in a single ledger_entry call.
 *
 * @throws LendingError on staleness or circuit breaker violations
 */
export async function getAllPrices(client: LendingClient): Promise<OraclePrice[]> {
  const node = await client.readOracleLedgerEntry(DIA_ORACLE_ACCOUNT, DIA_DOCUMENT_ID);

  const lastUpdateTime = (node.LastUpdateTime as number) ?? 0;
  const series = (node.PriceDataSeries as unknown[]) ?? [];

  const now = Math.floor(Date.now() / 1000);
  const isStale = now - lastUpdateTime > MAX_ORACLE_STALENESS;

  if (isStale) {
    throw new LendingError(
      LendingErrorCode.OracleStale,
      `Oracle data is stale (last update: ${lastUpdateTime})`,
    );
  }

  const results: OraclePrice[] = [];

  for (const asset of [AssetIndex.XRP, AssetIndex.RLUSD, AssetIndex.WBTC] as AssetIndex[]) {
    const ticker = ASSET_TICKERS[asset];
    const entry = parsePriceDataSeries(series, ticker);

    if (!entry || entry.assetPrice === 0n) {
      throw new LendingError(
        LendingErrorCode.OraclePriceZero,
        `No price entry for ${ticker}`,
      );
    }

    let priceWad = rawToWad(entry.assetPrice, entry.scale);

    // Apply RLUSD circuit breaker
    if (asset === AssetIndex.RLUSD) {
      priceWad = applyRlusdCircuitBreaker(priceWad);
    }

    results.push({
      assetIndex: asset,
      priceWad,
      lastUpdateTime,
      isStale: false,
    });
  }

  return results;
}
