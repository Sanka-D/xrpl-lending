/**
 * AlphaNet smoke test — verifies the full lending protocol on a live network.
 *
 * Flows tested:
 *   1. Oracle       — prices are fresh and non-zero for XRP, RLUSD, wBTC
 *   2. Supply       — Bob supplies XRP into the vault, gets shares, withdraws
 *   3. Collateral   — Alice deposits XRP as collateral, reads balance
 *   4. Borrow       — Alice borrows XRP, health factor > 1, repays, withdraws collateral
 *   5. Liquidation  — scan returns 0 opportunities; direct call on healthy position reverts
 *
 * Usage:
 *   ALICE_SECRET=sXxx BOB_SECRET=sXxx tsx smoke-test.ts
 *
 * Both accounts must be funded (≥ 1500 XRP on AlphaNet).
 * AlphaNet faucet: https://alphanet.nerdnest.xyz  (request XRP via the UI)
 *
 * Optional env:
 *   XRPL_WSS_URL           — override network (default: wss://alphanet.nerdnest.xyz)
 *   CONTROLLER_ADDRESS     — override contract address (default: from deployed.json)
 */

import { Wallet } from "xrpl";
import { LendingClient } from "xrpl-lending-sdk";
import {
  supply, withdraw, getSupplyShares,
} from "xrpl-lending-sdk";
import {
  depositCollateral, withdrawCollateral, getCollateralBalance,
} from "xrpl-lending-sdk";
import {
  borrow, repay, getDebtBalance,
} from "xrpl-lending-sdk";
import {
  getUserPosition, getAllPrices, findLiquidatablePositions, liquidate,
} from "xrpl-lending-sdk";
import { AssetIndex, WAD, ASSET_NAMES } from "xrpl-lending-sdk";
import { loadDeployedState, ALPHANET_WSS, log } from "./shared.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const ALICE_SECRET = process.env.ALICE_SECRET;
const BOB_SECRET   = process.env.BOB_SECRET;

if (!ALICE_SECRET || !BOB_SECRET) {
  console.error(
    "\n[smoke-test] Missing env vars.\n\n" +
    "  ALICE_SECRET=sXxx BOB_SECRET=sXxx tsx smoke-test.ts\n\n" +
    "Both accounts need ≥ 1500 XRP on AlphaNet.\n" +
    "Fund them at: https://alphanet.nerdnest.xyz\n",
  );
  process.exit(1);
}

const state = loadDeployedState();
const wsUrl = process.env.XRPL_WSS_URL ?? ALPHANET_WSS;
const contractAddress =
  process.env.CONTROLLER_ADDRESS ??
  state?.controllerAddress;

if (!contractAddress) {
  console.error(
    "[smoke-test] No contract address found.\n" +
    "Run deploy-controller.ts + setup-markets.ts first, or set CONTROLLER_ADDRESS.",
  );
  process.exit(1);
}

// ── Amounts (in drops / native units) ─────────────────────────────────────────

const XRP_DROPS = 1_000_000n;            // 1 XRP = 1e6 drops

const BOB_SUPPLY_AMOUNT    = 1_000n * XRP_DROPS;   // 1 000 XRP → liquidity
const ALICE_COLLATERAL     =   500n * XRP_DROPS;   //   500 XRP → collateral
const ALICE_BORROW_AMOUNT  =   200n * XRP_DROPS;   //   200 XRP → borrow (< 75% LTV of 500)
// Expected HF ≈ (500 × 80%) / 200 = 2.0

// ── Test runner ────────────────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; detail: string }
const results: TestResult[] = [];
let passed = 0;
let failed = 0;

function ok(name: string, detail = "") {
  results.push({ name, passed: true, detail });
  passed++;
  console.log(`  ✓ ${name}${detail ? "  →  " + detail : ""}`);
}

function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
  failed++;
  console.error(`  ✗ ${name}  →  ${detail}`);
}

async function run(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    fail(name, String(e));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(" XRPL Lending Protocol — AlphaNet Smoke Test");
  console.log("═══════════════════════════════════════════════════════");
  console.log(` Network:  ${wsUrl}`);
  console.log(` Contract: ${contractAddress}`);
  console.log("───────────────────────────────────────────────────────\n");

  const alice = Wallet.fromSecret(ALICE_SECRET!);
  const bob   = Wallet.fromSecret(BOB_SECRET!);
  console.log(` Alice: ${alice.classicAddress}`);
  console.log(` Bob:   ${bob.classicAddress}\n`);

  // Shared read client (no wallet needed for reads)
  const readClient = new LendingClient({ wsUrl, contractAddress: contractAddress! });

  // Per-wallet clients
  const aliceClient = new LendingClient({ wsUrl, contractAddress: contractAddress!, wallet: alice });
  const bobClient   = new LendingClient({ wsUrl, contractAddress: contractAddress!, wallet: bob   });

  await readClient.connect();
  (aliceClient as unknown as { xrplClient: typeof readClient["xrplClient"] }).xrplClient =
    readClient["xrplClient"];
  (bobClient   as unknown as { xrplClient: typeof readClient["xrplClient"] }).xrplClient =
    readClient["xrplClient"];

  try {
    // ── Phase 1: Oracle ───────────────────────────────────────────────────────
    console.log("── Phase 1: Oracle ─────────────────────────────────────");

    await run("oracle prices readable", async () => {
      const prices = await getAllPrices(readClient);
      if (prices.length !== 3) throw new Error(`Expected 3 prices, got ${prices.length}`);
      for (const p of prices) {
        if (p.priceWad === 0n) {
          throw new Error(`${ASSET_NAMES[p.assetIndex]} price is zero — oracle may be stale`);
        }
        ok(
          `${ASSET_NAMES[p.assetIndex]} price`,
          `$${Number(p.priceWad * 100n / WAD) / 100} USD (WAD: ${p.priceWad})`,
        );
      }
    });

    // ── Phase 2: Supply (vault deposit) ──────────────────────────────────────
    console.log("\n── Phase 2: Supply (vault deposit) ─────────────────────");

    let bobSharesBefore = 0n;
    let bobSharesAfterSupply = 0n;

    await run("Bob supplies 1000 XRP", async () => {
      bobSharesBefore = await getSupplyShares(bobClient, bob.classicAddress, AssetIndex.XRP);
      const res = await supply(bobClient, AssetIndex.XRP, BOB_SUPPLY_AMOUNT);
      if (res.engineResult !== "tesSUCCESS") {
        throw new Error(`tx ${res.hash} → ${res.engineResult}`);
      }
      ok("Bob supplies 1000 XRP", `tx: ${res.hash}`);
    });

    await run("Bob supply shares increased", async () => {
      bobSharesAfterSupply = await getSupplyShares(bobClient, bob.classicAddress, AssetIndex.XRP);
      if (bobSharesAfterSupply <= bobSharesBefore) {
        throw new Error(`Shares did not increase: ${bobSharesBefore} → ${bobSharesAfterSupply}`);
      }
      ok("Bob supply shares increased", `${bobSharesBefore} → ${bobSharesAfterSupply}`);
    });

    // ── Phase 3: Collateral ───────────────────────────────────────────────────
    console.log("\n── Phase 3: Collateral ─────────────────────────────────");

    await run("Alice deposits 500 XRP as collateral", async () => {
      const res = await depositCollateral(aliceClient, AssetIndex.XRP, ALICE_COLLATERAL);
      if (res.engineResult !== "tesSUCCESS") {
        throw new Error(`tx ${res.hash} → ${res.engineResult}`);
      }
      ok("Alice deposits 500 XRP collateral", `tx: ${res.hash}`);
    });

    await run("Alice collateral balance ≥ 500 XRP", async () => {
      const col = await getCollateralBalance(aliceClient, alice.classicAddress, AssetIndex.XRP);
      if (col < ALICE_COLLATERAL) {
        throw new Error(`Expected ≥ ${ALICE_COLLATERAL} drops, got ${col}`);
      }
      ok("Alice collateral balance", `${Number(col) / 1e6} XRP`);
    });

    // ── Phase 4: Borrow / HF / Repay / Withdraw ──────────────────────────────
    console.log("\n── Phase 4: Borrow / Health Factor / Repay ─────────────");

    await run("Alice borrows 200 XRP", async () => {
      const res = await borrow(aliceClient, AssetIndex.XRP, ALICE_BORROW_AMOUNT);
      if (res.engineResult !== "tesSUCCESS") {
        throw new Error(`tx ${res.hash} → ${res.engineResult}`);
      }
      ok("Alice borrows 200 XRP", `tx: ${res.hash}`);
    });

    await run("Alice debt balance ≥ 200 XRP", async () => {
      const debt = await getDebtBalance(aliceClient, alice.classicAddress, AssetIndex.XRP);
      if (debt < ALICE_BORROW_AMOUNT) {
        throw new Error(`Expected ≥ ${ALICE_BORROW_AMOUNT} drops debt, got ${debt}`);
      }
      ok("Alice debt balance", `${Number(debt) / 1e6} XRP`);
    });

    await run("Alice health factor > 1.0", async () => {
      const view = await getUserPosition(aliceClient, alice.classicAddress);
      const hfFloat = Number(view.healthFactor) / Number(WAD);
      if (view.healthFactor < WAD) {
        throw new Error(`HF = ${hfFloat.toFixed(4)} — position is liquidatable!`);
      }
      ok("Alice health factor", `${hfFloat.toFixed(4)}`);
    });

    // Over-borrow attempt: should be REJECTED by the contract
    await run("Over-borrow rejected (400 XRP > LTV capacity)", async () => {
      // 500 XRP * 75% LTV = 375 XRP capacity; 200 already borrowed → 175 left
      // Try to borrow 300 more XRP (total = 500 > capacity)
      const res = await borrow(aliceClient, AssetIndex.XRP, 300n * XRP_DROPS);
      if (res.engineResult === "tesSUCCESS") {
        throw new Error("Over-borrow should have been rejected but was accepted!");
      }
      ok("Over-borrow correctly rejected", `engineResult: ${res.engineResult}`);
    });

    // Repay
    await run("Alice repays debt", async () => {
      const debt = await getDebtBalance(aliceClient, alice.classicAddress, AssetIndex.XRP);
      // Add 1% buffer for accrued interest between read and submit
      const repayAmount = debt + debt / 100n + 1n;
      const res = await repay(aliceClient, AssetIndex.XRP, repayAmount);
      if (res.engineResult !== "tesSUCCESS") {
        throw new Error(`tx ${res.hash} → ${res.engineResult}`);
      }
      ok("Alice repays debt", `tx: ${res.hash}`);
    });

    await run("Alice debt = 0 after repay", async () => {
      const debt = await getDebtBalance(aliceClient, alice.classicAddress, AssetIndex.XRP);
      if (debt !== 0n) {
        throw new Error(`Expected 0 debt, got ${debt}`);
      }
      ok("Alice debt cleared", "0 XRP");
    });

    // Withdraw collateral
    await run("Alice withdraws collateral", async () => {
      const col = await getCollateralBalance(aliceClient, alice.classicAddress, AssetIndex.XRP);
      const res = await withdrawCollateral(aliceClient, AssetIndex.XRP, col);
      if (res.engineResult !== "tesSUCCESS") {
        throw new Error(`tx ${res.hash} → ${res.engineResult}`);
      }
      ok("Alice withdraws collateral", `tx: ${res.hash}`);
    });

    await run("Alice collateral = 0 after withdrawal", async () => {
      const col = await getCollateralBalance(aliceClient, alice.classicAddress, AssetIndex.XRP);
      if (col !== 0n) {
        throw new Error(`Expected 0 collateral, got ${col}`);
      }
      ok("Alice collateral cleared", "0 XRP");
    });

    // ── Phase 5: Liquidation ──────────────────────────────────────────────────
    console.log("\n── Phase 5: Liquidation ────────────────────────────────");

    await run("No liquidatable positions (Alice + Bob both healthy)", async () => {
      const opps = await findLiquidatablePositions(readClient, [
        alice.classicAddress,
        bob.classicAddress,
      ]);
      if (opps.length > 0) {
        const list = opps.map(o => `${o.borrower} HF=${Number(o.healthFactor) / Number(WAD)}`).join(", ");
        throw new Error(`Unexpected liquidatable positions: ${list}`);
      }
      ok("Liquidation scan", "0 opportunities found");
    });

    await run("Liquidation call on healthy account reverts", async () => {
      // Bob is a supplier with no debt → liquidating him should fail
      const res = await liquidate(aliceClient, {
        borrower: bob.classicAddress,
        debtAsset: AssetIndex.XRP,
        collateralAsset: AssetIndex.XRP,
        debtAmount: 1n * XRP_DROPS,
      });
      if (res.engineResult === "tesSUCCESS") {
        throw new Error("Liquidation of healthy account should have been rejected!");
      }
      ok("Liquidation guard works", `engineResult: ${res.engineResult}`);
    });

    // Bob withdraws supply shares (cleanup)
    console.log("\n── Cleanup ─────────────────────────────────────────────");

    await run("Bob withdraws supply shares", async () => {
      const shares = await getSupplyShares(bobClient, bob.classicAddress, AssetIndex.XRP);
      if (shares === 0n) {
        ok("Bob supply shares already 0 (skipping)", "");
        return;
      }
      const res = await withdraw(bobClient, AssetIndex.XRP, shares);
      if (res.engineResult !== "tesSUCCESS") {
        throw new Error(`tx ${res.hash} → ${res.engineResult}`);
      }
      ok("Bob withdraws supply shares", `tx: ${res.hash}`);
    });

  } finally {
    await readClient.disconnect();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(` RESULTS:  ${passed} passed,  ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ✗ ${r.name}  →  ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error("\n[smoke-test] Fatal error:", e);
  process.exit(1);
});
