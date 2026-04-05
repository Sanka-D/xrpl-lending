import { describe, it, expect, vi } from "vitest";
import { rawToWad, applyRlusdCircuitBreaker, getPrice, getAllPrices } from "../oracle";
import { WAD, AssetIndex, LendingErrorCode } from "../types";
import { createMockClient, mockOracleNode } from "./helpers/mock-client";

// ── rawToWad ──────────────────────────────────────────────────────────────────

describe("rawToWad", () => {
  it("scale -8: XRP $2.00 → 2e18", () => {
    // assetPrice = 200_000_000, scale = -8 → 200M * 10^10 = 2e18
    expect(rawToWad(200_000_000n, -8)).toBe(2n * WAD);
  });

  it("scale -8: RLUSD $1.00 → 1e18", () => {
    expect(rawToWad(100_000_000n, -8)).toBe(WAD);
  });

  it("scale -8: BTC $60,000 → 60000e18", () => {
    expect(rawToWad(6_000_000_000_000n, -8)).toBe(60_000n * WAD);
  });

  it("scale 0: identity multiply", () => {
    expect(rawToWad(1n, 0)).toBe(10n ** 18n);
  });
});

// ── applyRlusdCircuitBreaker ──────────────────────────────────────────────────

describe("applyRlusdCircuitBreaker", () => {
  it("price at peg ($1.00) returns 1 WAD", () => {
    expect(applyRlusdCircuitBreaker(WAD)).toBe(WAD);
  });

  it("price at lower bound ($0.95) returns 1 WAD", () => {
    const low = (WAD * 95n) / 100n;
    expect(applyRlusdCircuitBreaker(low)).toBe(WAD);
  });

  it("price at upper bound ($1.05) returns 1 WAD", () => {
    const high = (WAD * 105n) / 100n;
    expect(applyRlusdCircuitBreaker(high)).toBe(WAD);
  });

  it("price below lower bound throws OracleCircuitBreaker", () => {
    const tooLow = (WAD * 94n) / 100n;
    expect(() => applyRlusdCircuitBreaker(tooLow)).toThrow();
  });

  it("price above upper bound throws OracleCircuitBreaker", () => {
    const tooHigh = (WAD * 106n) / 100n;
    expect(() => applyRlusdCircuitBreaker(tooHigh)).toThrow();
  });
});

// ── getAllPrices ──────────────────────────────────────────────────────────────

describe("getAllPrices", () => {
  it("happy path: returns 3 prices for XRP, RLUSD, wBTC", async () => {
    const oracle = mockOracleNode({
      xrpPrice: 2n * WAD,
      rlusdPrice: WAD,
      btcPrice: 60_000n * WAD,
    });
    const client = createMockClient({
      readOracleLedgerEntry: vi.fn(async () => oracle),
    });

    const prices = await getAllPrices(client);
    expect(prices).toHaveLength(3);
    expect(prices[0].assetIndex).toBe(AssetIndex.XRP);
    expect(prices[0].priceWad).toBe(2n * WAD);
    expect(prices[1].assetIndex).toBe(AssetIndex.RLUSD);
    expect(prices[1].priceWad).toBe(WAD); // circuit breaker snaps to 1.0
    expect(prices[2].assetIndex).toBe(AssetIndex.WBTC);
    expect(prices[2].priceWad).toBe(60_000n * WAD);
  });

  it("stale oracle throws OracleStale", async () => {
    const stalePast = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const oracle = mockOracleNode({
      xrpPrice: 2n * WAD,
      rlusdPrice: WAD,
      btcPrice: 60_000n * WAD,
      lastUpdateTime: stalePast,
    });
    const client = createMockClient({
      readOracleLedgerEntry: vi.fn(async () => oracle),
    });

    await expect(getAllPrices(client)).rejects.toThrow();
  });

  it("missing price entry throws OraclePriceZero", async () => {
    const oracle = {
      LedgerEntryType: "Oracle",
      LastUpdateTime: Math.floor(Date.now() / 1000),
      PriceDataSeries: [
        { PriceData: { BaseAsset: "XRP", QuoteAsset: "USD", AssetPrice: "200000000", Scale: -8 } },
        // RLUSD missing
        { PriceData: { BaseAsset: "BTC", QuoteAsset: "USD", AssetPrice: "6000000000000", Scale: -8 } },
      ],
    };
    const client = createMockClient({
      readOracleLedgerEntry: vi.fn(async () => oracle),
    });

    await expect(getAllPrices(client)).rejects.toThrow();
  });
});

// ── getPrice ──────────────────────────────────────────────────────────────────

describe("getPrice", () => {
  it("returns price for requested asset", async () => {
    const oracle = mockOracleNode({
      xrpPrice: 2n * WAD,
      rlusdPrice: WAD,
      btcPrice: 60_000n * WAD,
    });
    const client = createMockClient({
      readOracleLedgerEntry: vi.fn(async () => oracle),
    });

    const price = await getPrice(client, AssetIndex.WBTC);
    expect(price.assetIndex).toBe(AssetIndex.WBTC);
    expect(price.priceWad).toBe(60_000n * WAD);
  });
});
