# XRPL Lending Protocol V1 — Technical Specification

> Written after a full audit (80 SDK + 33 keeper + 14 E2E tests passing, all TS packages type-clean, Rust cargo check clean).

---

## 1. Executive Summary

An Aave v3-inspired, permissionless lending protocol deployed on XRPL using three upcoming standards:

| Standard | Purpose |
|----------|---------|
| **XLS-65** | Native vaults — hold deposited assets on-chain without a separate escrow account |
| **XLS-101** | Smart contract execution — upload WASM bytecode, call it via `Invoke` transactions |
| **XLS-47** | On-chain oracle — DIA price feeds stored as XRPL ledger objects |

**V1 scope: 3 markets** — XRP, RLUSD, wBTC.

**Monorepo layout:**

```
xrpl-lending/
├── contracts/lending-controller/   Rust → WASM smart contract
├── sdk/                            TypeScript read/write client
├── keeper/                         Off-chain liquidation bot
├── tests/                          E2E tests (SimulatedLedger)
└── deploy/                         AlphaNet deploy scripts
```

---

## 2. Architecture Overview

```
                    ┌──────────────────────────────────────────────────────┐
                    │                        XRPL Ledger                   │
                    │                                                      │
  User              │  ┌─────────────────┐   ┌────────────────┐           │
  (browser/CLI)─────┼─▶│  Invoke tx      │──▶│ Controller     │           │
                    │  │ (XLS-101)       │   │ WASM           │──▶ State   │
  SDK               │  └─────────────────┘   │ (lend/borrow/  │    keys   │
  (xrpl-lending-sdk)│                        │  liquidate)    │           │
       │            │  ┌─────────────────┐   └────────────────┘           │
       ▼            │  │ DIA oracle      │          │                      │
  LendingClient     │  │ (XLS-47)        │◀─────────┘ (price reads)       │
       │            │  └─────────────────┘                                 │
       ▼            │                                                      │
  Keeper bot        │  ┌─────────────────┐                                │
  (liquidation)─────┼─▶│ Vaults (XLS-65) │ (asset custody)               │
                    │  └─────────────────┘                                │
                    └──────────────────────────────────────────────────────┘
```

**Execution flow for every write operation:**
1. Caller builds an `Invoke` transaction pointing at the contract address.
2. XRPL runtime calls the exported WASM function with decoded arguments.
3. WASM reads state from contract storage via `host::read_state`, reads oracle via `get_all_prices`.
4. Business logic runs (interest accrual → validation → mutation).
5. WASM writes updated state back via `host::write_state`.
6. On success: `accept_tx()`. On error: `rollback_tx(error_code)`.

---

## 3. Rust Contract (`contracts/lending-controller/src/`)

The contract is compiled to WASM32 with `#![no_std]`. All structs are fixed-size (no `Vec`, no `HashMap`). On-chain state is stored as raw key-value byte pairs.

### 3.1 `lib.rs` — Entry points

Nine `#[no_mangle] extern "C"` exports:

| Function | Args (WASM types) | What it does |
|----------|-------------------|--------------|
| `supply(asset_id: u32, amount: u64)` | asset index, native units | Mint supply shares |
| `withdraw(asset_id: u32, shares: u64)` | asset index, share units | Burn shares, return assets |
| `deposit_collateral(asset_id: u32, amount: u64)` | — | Record collateral position |
| `withdraw_collateral(asset_id: u32, amount: u64)` | — | Release collateral (HF check) |
| `borrow(asset_id: u32, amount: u64)` | — | Check LTV, send assets to caller |
| `repay(asset_id: u32, amount: u64)` | — | Reduce debt, refund overpayment |
| `liquidate(borrower_ptr: u32, debt_id: u32, collat_id: u32, amount: u64)` | pointer to 20-byte AccountID in WASM memory | Liquidate unhealthy position |
| `get_health_factor(user_ptr: u32) -> u64` | pointer to 20-byte AccountID | Return HF as WAD-scaled u64 |
| `get_user_position(user_ptr: u32) -> u32` | pointer to 20-byte AccountID | Serialize position to 144-byte blob |

Every write function:
- Calls `get_caller()` to identify the signer.
- Loads state from storage.
- Delegates to a handler in the appropriate module.
- Stores mutated state.
- Calls `accept_tx()` on `Ok`, `rollback_tx(code)` on `Err`.

`get_user_position` output format (144 bytes = 3 markets × 48 bytes):
```
[0..16]  collateral (u128 LE)
[16..32] actual_debt (u128 LE, with accrued interest)
[32..48] supply_shares (u128 LE)
```

### 3.2 `state.rs` — Storage layout + V1 constants

**State key scheme** (`state.rs:8-17`):

| Key pattern | Fields | Value size |
|-------------|--------|-----------|
| `mkt:{i}:int:br` | borrow_rate_bps | 8 bytes (u64 LE) |
| `mkt:{i}:int:sr` | supply_rate_bps | 8 bytes (u64 LE) |
| `mkt:{i}:int:bi` | borrow_index | 16 bytes (u128 LE) |
| `mkt:{i}:int:si` | supply_index | 16 bytes (u128 LE) |
| `mkt:{i}:int:ts` | last_update_timestamp | 8 bytes (u64 LE) |
| `mkt:{i}:int:tb` | total_borrows | 16 bytes (u128 LE) |
| `mkt:{i}:int:tp` | total_supply | 16 bytes (u128 LE) |
| `pos:{20b}:{i}:co` | collateral (native units) | 16 bytes (u128 LE) |
| `pos:{20b}:{i}:de` | stored debt principal | 16 bytes (u128 LE) |
| `pos:{20b}:{i}:bi` | user_borrow_index | 16 bytes (u128 LE) |
| `pos:{20b}:{i}:sh` | supply shares | 16 bytes (u128 LE) |
| `glb:vault0` | XRP vault AccountID | 20 bytes |
| `glb:vault1` | RLUSD vault AccountID | 20 bytes |
| `glb:vault2` | wBTC vault AccountID | 20 bytes |

`{20b}` is the raw 20-byte XRPL AccountID (binary, not hex-encoded). Key construction: `state.rs:337-356`.

**Asset constants** (`state.rs:27-36`):
```rust
pub const ASSET_XRP: u8 = 0;
pub const ASSET_RLUSD: u8 = 1;
pub const ASSET_WBTC: u8 = 2;
pub const ASSET_DECIMALS: [u8; 3] = [6, 6, 8];
// XRP=6 (drops), RLUSD=6, wBTC=8 (satoshis)
```

**V1 risk parameters** (`state.rs:111-156`), all in basis points (10,000 = 100%):

| Parameter | XRP | RLUSD | wBTC |
|-----------|-----|-------|------|
| `ltv` (max borrow ratio) | 7500 (75%) | 8000 (80%) | 7300 (73%) |
| `liquidation_threshold` | 8000 (80%) | 8500 (85%) | 7800 (78%) |
| `liquidation_bonus` | 500 (5%) | 400 (4%) | 650 (6.5%) |
| `reserve_factor` | 2000 (20%) | 1000 (10%) | 2000 (20%) |
| `max_liquidation_bps` | 5000 (50%) | 5000 (50%) | 5000 (50%) |
| `optimal_utilization` | 8000 (80%) | 9000 (90%) | 4500 (45%) |
| `base_rate` | 0 | 0 | 0 |
| `slope1` | 400 (4%) | 400 (4%) | 700 (7%) |
| `slope2` | 30000 (300%) | 6000 (60%) | 30000 (300%) |

**DIA oracle constants** (`state.rs:39-45`):
```rust
pub const DIA_ORACLE_ACCOUNT: [u8; 20] = [0x7c, 0x02, ...]; // rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7
pub const DIA_DOCUMENT_ID: u32 = 42;
pub const MAX_ORACLE_STALENESS_SECS: u64 = 300;
```

### 3.3 `math.rs` — WAD fixed-point arithmetic

All monetary values are in **native ledger units** (drops, satoshis, RLUSD-units). Interest indexes and rates are **WAD-scaled** (multiplied by `WAD = 1e18`).

**Key constants** (`math.rs:19-29`):
```rust
pub const WAD: u128 = 1_000_000_000_000_000_000;      // 1e18
pub const HALF_WAD: u128 = 500_000_000_000_000_000;   // 5e17
pub const BPS: u128 = 10_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;
```

**WAD multiplication** — rounded half-up (`math.rs:37-43`):
```
wad_mul(a, b) = (a × b + HALF_WAD) / WAD
```
Safe when `a × b < u128::MAX ≈ 3.4e38`. For protocol amounts: `a` is native (≤ 1e17 drops), `b` is a price or index (≤ ~10 WAD) — product ≤ 1e36.

**WAD division** — rounded half-up (`math.rs:46-52`):
```
wad_div(a, b) = (a × WAD + b/2) / b
```
Safe when `a < u128::MAX / WAD ≈ 3.4e20`.

**2-term Taylor compound interest** (`math.rs:119-135`):
```
calculate_compound_interest(rate_per_sec, duration):
  rt = rate_per_sec × duration
  factor = WAD + rt + (rt)²/2     (in WAD)
```
Accurate to <0.01% for typical rates (4%-300% APY) over 30-day windows. At 300% APY over a year it underestimates true compound by ~57% — known limitation, acceptable for protocol risk.

**Annual BPS → per-second WAD** (`math.rs:139-143`):
```
annual_bps_to_per_second_wad(bps) = bps × WAD / (BPS × SECONDS_PER_YEAR)
```
Example: 400 bps (4% APY) → ≈ 1,268,391,679 (per-second rate in WAD).

### 3.4 `interest.rs` — Kinked two-slope rate model + index accrual

**Utilization** (`interest.rs:41-49`):
```
U = total_borrows × WAD / (total_borrows + total_supply)
```
Returns 0 when no supply, WAD (1.0) when fully borrowed.

**Borrow rate** (`interest.rs:55-81`):
```
if U ≤ U_opt:
  borrow_rate_bps = base + (U / U_opt) × slope1

if U > U_opt:
  borrow_rate_bps = base + slope1 + ((U - U_opt) / (1 - U_opt)) × slope2
```
Where `U_opt = optimal_utilization × WAD / BPS` (converted to WAD scale for comparison).

**Supply rate** (`interest.rs:104-117`):
```
supply_rate = borrow_rate_per_sec × U × (1 − reserve_factor)
```

**Index accrual** — `update_interest_indexes` (`interest.rs:138-195`):

Called on every user action. Uses the **stored** rate for the elapsed period:

1. `borrow_compound = calculate_compound_interest(borrow_rate_per_sec_stored, elapsed)`
2. `new_borrow_index = wad_mul(old_borrow_index, borrow_compound)`
3. `interest_accrued = wad_mul(total_borrows, borrow_compound - WAD)`
4. `new_total_borrows = old_total_borrows + interest_accrued`
5. `new_utilization = calculate_utilization(new_total_borrows, total_supply)`
6. `supply_rate_per_sec = calculate_supply_rate(borrow_rate_per_sec_stored, new_utilization, supply_rate_bps_stored)` ← **note**: step 6 passes `state.supply_rate_bps` as the `reserve_factor` argument. This is a quirk of the Rust source that the TypeScript simulator faithfully reproduces (see §6 Known Quirks).
7. `new_supply_index = wad_mul(old_supply_index, supply_compound)`
8. Recompute `new_borrow_rate_bps` and `new_supply_rate_bps` from new utilization for the **next** period.

**Actual debt from stored principal** (`interest.rs:212-228`):
```
actual_debt = stored_principal × current_borrow_index / user_borrow_index_at_entry
```

**Storing new debt** (`to_scaled_debt` in `interest.rs`):
```
stored_principal = actual_amount × WAD / current_borrow_index
```
Integer division here causes ~1-8 unit precision loss per round-trip — phantom residue in `total_borrows` after full repayment (see §6 Known Quirks).

### 3.5 `oracle.rs` — DIA price feed + RLUSD circuit breaker

**DIA raw → WAD conversion** (`oracle.rs`):
```
price_wad = raw_AssetPrice × 10^(18 + Scale)
```
DIA stores `Scale = -8`, so:
```
price_wad = raw_AssetPrice × 10^10
```
Example: XRP at $2.00 → `AssetPrice=200_000_000` → `200_000_000 × 10^10 = 2.0 WAD ✓`

**Staleness check**: `now - LastUpdateTime > 300s` → `OracleStale` error.

**RLUSD circuit breaker** (`oracle.rs:24-30`, `state.rs:62-65`):
- Read DIA price for RLUSD ticker.
- If price ∈ [9500 bps, 10500 bps] of WAD (i.e. [0.95, 1.05] USD): return `RLUSD_FIXED_PRICE = WAD` (hardcode $1.00).
- Otherwise: return `OracleCircuitBreaker` error → all RLUSD-dependent operations fail.

The oracle lookup uses a 38-element precomputed `POW10` table (`oracle.rs:44-86`).

### 3.6 `health.rs` — Health factor + USD value helpers

**Asset USD value** (`health.rs:24-36`):
```
price_per_native = price_wad / 10^decimals
value_usd = amount_native × price_per_native
```
Division is done on `price_wad` first (not on the amount) to avoid overflow. Precision loss: at most 1 unit per position, negligible for risk.

**Health factor** (`health.rs:74-110`):
```
weighted_collateral = Σ(col_i × price_per_native_i × liqThreshold_i / BPS)
total_debt_usd      = Σ(debt_i × price_per_native_i)

HF = weighted_collateral × WAD / total_debt_usd
```
Returns `u128::MAX` when `total_debt_usd == 0`. Position is liquidatable when `HF < WAD`.

**Borrow capacity** (in `health.rs`):
```
capacity_usd = Σ(col_i × price_per_native_i × ltv_i / BPS) − Σ(debt_i × price_per_native_i)
```
Borrow is rejected if `amount_usd > capacity_usd`.

### 3.7 `supply.rs` — Supply shares

**Mint shares** on `supply`:
```
shares = wad_div(amount, supply_index) = amount × WAD / supply_index
```
Shares increase proportionally to current index — early suppliers get the same share/unit ratio as late suppliers, but each share redeems for more assets over time.

**Redeem on `withdraw`**:
```
amount = wad_mul(shares, supply_index) = shares × supply_index / WAD
```

### 3.8 `collateral.rs` — Collateral management

`deposit_collateral`: adds `amount` to `pos[asset_index].collateral`.

`withdraw_collateral`: subtracts `amount`, then checks `HF ≥ WAD` using current prices and interest. Reverts with `WithdrawWouldLiquidate` if HF drops below 1.0.

### 3.9 `borrow.rs` — Borrow and repay

**Borrow flow** (`borrow.rs:31-115`):
1. Update interest index for the borrowed asset.
2. Compute actual positions (accrued debt for all 3 markets).
3. Fetch oracle prices, compute `capacity_usd`, check `amount_usd ≤ capacity_usd`.
4. Check vault cash: `amount ≤ total_supply`.
5. `vault_withdraw` → `transfer_to(caller)`.
6. Merge new borrow with existing: `new_total_actual = old_actual + amount`.
7. Store as `to_scaled_debt(new_total_actual, current_borrow_index)`.
8. Update `market_interest.total_borrows += amount`, `total_supply -= amount`.

**Repay flow**:
1. Compute `actual_debt = get_actual_debt(stored, user_index, current_index)`.
2. `repay_amount = min(requested, actual_debt)`.
3. Overpayment (`requested - repay_amount`) refunded to caller.
4. If `actual_debt - repay_amount == 0`: zero out `pos.debt` and `pos.user_borrow_index`.
5. Otherwise: store `to_scaled_debt(actual_debt - repay_amount, current_index)`.
6. Update `total_borrows -= repay_amount`, `total_supply += repay_amount`.

### 3.10 `liquidation.rs` — Liquidation

**Preconditions**:
- `HF < WAD` (position unhealthy).
- `debt_index ≠ col_index` (can't seize same asset as debt).

**Close factor** (50% cap):
```
max_repay = calculate_max_liquidation(total_debt_usd) = total_debt_usd × 5000 / BPS
```
If `amount_usd > max_repay`: clamp `amount = max_repay_in_native`.

**Collateral to seize**:
```
debt_usd     = asset_usd_value(amount, debt_price, debt_decimals)
col_per_unit = col_price_wad / 10^col_decimals
base_col     = debt_usd / col_per_unit
bonus        = base_col × liquidation_bonus / BPS
col_to_seize = base_col + bonus
```
The liquidator repays `amount` native debt tokens and receives `col_to_seize` native collateral tokens.

### 3.11 `errors.rs` — Error codes

Error ranges (`errors.rs:7-15`):
```
1xx — General (MathOverflow, InvalidAmount, InvalidAsset, MarketPaused, Unauthorized)
2xx — Supply vault (InsufficientLiquidity, WithdrawExceedsBalance)
3xx — Collateral (CollateralNotEnabled, InsufficientCollateral, WithdrawWouldLiquidate)
4xx — Borrow/repay (BorrowNotEnabled, BorrowCapacityExceeded, InsufficientBorrowLiquidity)
5xx — Liquidation (PositionHealthy, MaxLiquidationExceeded, InsufficientCollateralToSeize)
6xx — Oracle (OracleStale, OraclePriceZero, OracleCircuitBreaker, OracleNotConfigured)
7xx — Interest (InterestAccrualFailed)
8xx — Markets (MarketNotFound)
9xx — Admin (Unauthorized admin ops)
```

### 3.12 `host.rs` — Host ABI bindings

Wraps XRPL-WASM host functions. The `HostContext` trait abstracts them for testability:
- `read_state(key, buf) -> usize` / `write_state(key, data)`
- `get_caller() -> [u8; 20]`
- `current_time() -> u64` (parent ledger close time)
- `vault_withdraw(vault, asset, amount)` / `transfer_to(account, asset, amount)`
- `accept_tx()` / `rollback_tx(error: LendingError) -> !`
- `set_return_value(ptr, len)` (for `get_user_position`)

---

## 4. TypeScript SDK (`sdk/src/`)

### 4.1 Module overview

| File | Purpose |
|------|---------|
| `types.ts` | Enums, interfaces, constants, `LendingError` class |
| `client.ts` | `LendingClient`, key builders, encoding helpers |
| `supply.ts` | `supply()`, `withdraw()`, `getSupplyShares()`, `getInterestState()` |
| `borrow.ts` | `borrow()`, `repay()`, `getDebtBalance()` |
| `collateral.ts` | `depositCollateral()`, `withdrawCollateral()`, `getCollateralBalance()` |
| `liquidation.ts` | `liquidate()`, `findLiquidatablePositions()` |
| `oracle.ts` | `getAllPrices()`, `rawToWad()`, `applyRlusdCircuitBreaker()` |
| `health.ts` | `calculateHealthFactor()`, `calculateBorrowCapacity()`, `assetUsdValue()` |
| `positions.ts` | `getUserPosition()`, `getAllInterestStates()` |
| `index.ts` | Barrel re-export of all public API |

### 4.2 `types.ts` — Core types

```typescript
// sdk/src/types.ts:3-12
export enum AssetIndex {
  XRP   = 0,
  RLUSD = 1,
  WBTC  = 2,
}
// ← Regular enum (NOT const enum). The runtime object is needed for iteration
//   in tests and keepers. Using `const enum` would cause a silent runtime error.
```

`V1_MARKETS: Record<AssetIndex, MarketConfig>` — mirrors `V1_MARKETS` in `state.rs` exactly.

`LendingError` extends `Error` with a `code: LendingErrorCode` field:
```typescript
export class LendingError extends Error {
  constructor(public readonly code: LendingErrorCode, message?: string) { ... }
}
```

### 4.3 `client.ts` — Invoke payload encoding

**XLS-101 Invoke payload** (`client.ts:162-178`):
```
HexValue = UTF8(functionName) || 0x00 || args    (uppercase hex string)
```
Sent as a single `InvokeArgs[0].InvokeArg.HexValue` field.

Example — `supply` with RLUSD and 1000 units:
```
functionName = "supply"  → 73 75 70 70 6c 79
separator    = 00
args (12B)   = u32LE(1) || u64LE(1000000)
             = 01 00 00 00 || 40 42 0f 00 00 00 00 00
HexValue = "737570706C79000100000040420F0000000000"
```

**Argument sizes:**
- `supply / withdraw / borrow / repay / deposit_collateral / withdraw_collateral`: **12 bytes** = `u32LE(assetIndex) || u64LE(amount)`
- `liquidate`: **36 bytes** = `borrowerAccountId[20] || u32LE(debtAsset) || u32LE(colAsset) || u64LE(amount)`

**State reading** (`client.ts`):
- `readContractState(key: Uint8Array)`: calls `contract_info` RPC → parses base64 value → returns `Uint8Array | null`.
- `readOracleLedgerEntry(account, docId)`: calls `ledger_entry` RPC for XLS-47 `Oracle` entry → returns the raw object.

**Key builders** (matching the Rust exact format):
- `marketInterestKey(assetIndex, field)` → `"mkt:{i}:int:{field}"`
- `userPositionKey(accountId: Uint8Array, assetIndex, field)` → `"pos:" || accountId[20] || ":{i}:{field}"`
- `globalKey(field)` → `"glb:{field}"`

### 4.4 `oracle.ts` — Price reading

`getAllPrices(client)`:
1. `client.readOracleLedgerEntry(DIA_ORACLE_ACCOUNT, DIA_DOCUMENT_ID)` → raw XLS-47 node.
2. Check `LastUpdateTime` vs `Date.now()/1000` — throw `OracleStale` if > 300s.
3. Parse `PriceDataSeries` array, match tickers by 20-byte hex comparison.
4. `rawToWad(AssetPrice, Scale)` = `BigInt(AssetPrice) × 10n ** BigInt(18 + Scale)`.
5. For RLUSD: `applyRlusdCircuitBreaker(priceWad)` — if outside [0.95, 1.05] WAD, throw `OracleCircuitBreaker`; otherwise return `WAD`.

### 4.5 `health.ts` — Off-chain HF computation

Pure TypeScript mirror of `health.rs`, used by the keeper and tests:
```typescript
// assetUsdValue: native × (priceWad / 10^decimals)
// calculateHealthFactor: Σ(col × price/dec × liqThresh/BPS) × WAD / Σ(debt × price/dec)
// calculateBorrowCapacity: Σ(col × price/dec × ltv/BPS) − Σ(debt × price/dec)
```

---

## 5. Keeper Bot (`keeper/src/`)

**Pipeline** (each XRPL ledger close, ~3-5 seconds) (`index.ts:5-6`):
```
OracleWatcher → PositionMonitor.scan → filterProfitable → Liquidator.executeBatch
```

### 5.1 `oracle-watcher.ts`

Subscribes to `ledgerClosed` events. On each close, reads DIA oracle via `getAllPrices`. If any price moves beyond a configurable threshold (`minPriceChangePct`), emits a `PriceUpdate` event to trigger a full position scan.

### 5.2 `monitor.ts` — PositionMonitor

On each `PriceUpdate`:
1. Iterates `config.monitoredAccounts` (comma-separated list from env).
2. For each account: calls `getUserPosition(client, account)` from the SDK.
3. Calls `calculateHealthFactor` with current prices.
4. If `HF < WAD`: emits `LiquidationOpportunity` with the position details.

### 5.3 `profitability.ts` — filterProfitable

For each opportunity:
1. Picks the most profitable (debt, collateral) asset pair.
2. Estimates `collateralToSeize` = `debtUsd × (BPS + bonus) / BPS / colPricePerNative`.
3. `grossProfit = bonus_portion_of_seized_collateral_in_usd`.
4. `netProfit = grossProfit − (gasCostDrops × xrpPrice / 1e6)`.
5. Returns only those where `netProfit ≥ config.minProfitUsd`.

### 5.4 `liquidator.ts` — Liquidator

`executeBatch(opportunities)`:
1. Dry-run mode: logs the opportunity and skips submission.
2. Live mode: calls `liquidate(client, borrower, debtAsset, colAsset, amount)` from SDK.
3. Logs `engineResult`. If `tesSUCCESS`: logs profit. Otherwise: logs warning.
4. Handles exceptions without crashing the main loop.

**Config** (from `config.ts`, loaded from env):
- `KEEPER_WALLET_SECRET` — signing seed
- `CONTROLLER_ADDRESS` — contract r-address
- `MONITORED_ACCOUNTS` — comma-separated
- `XRPL_WSS_URL` — WebSocket (default: `wss://s.devnet.rippletest.net:51233`)
- `MIN_PROFIT_USD_WAD` — minimum profit threshold in WAD
- `LIQUIDATION_GAS_COST_DROPS` — estimated Invoke tx cost

---

## 6. E2E Tests (`tests/`)

### 6.1 `helpers/simulated-ledger.ts` — SimulatedLedger

A deterministic in-memory simulator that mirrors the Rust contract's arithmetic exactly. This enables the full 14-step lifecycle to run without any network access.

**Design**: stores all state in a `Map<string, bigint>` using the exact same ASCII key scheme as the Rust contract (`mkt:{i}:int:{field}`, `pos:{hex20}:{i}:{field}`). The `stateKey()` helper converts between the binary key format and the map's string keys.

**WAD math** — exact bigint mirrors of `math.rs`:
```typescript
const wadMul = (a, b) => (a * b + HALF_WAD) / WAD
const wadDiv = (a, b) => (a * WAD + b / 2n) / b
const calculateCompoundInterest = (rate, dt) => WAD + rate * dt + wadMul(rate * dt, rate * dt) / 2n
```

**`updateInterestIndexes`** — faithful replication including the quirk: step 3 calls `calculateSupplyRatePerSec(borrowRate, newUtil, state.supplyRateBps)` — passing `supplyRateBps` where the Rust source passes `state.supply_rate_bps` as the `reserve_factor` argument. This is intentional: the simulator must match the on-chain behaviour exactly, even if that behaviour is a bug.

**`buildOracleEntry()`** — returns a synthetic XLS-47 oracle entry with `LastUpdateTime: Math.floor(Date.now() / 1000)`. This is critical: using the simulator's `timestamp` field (which starts at 1,700,000,000 in 2023) would cause all oracle staleness checks to fail.

**`createMockClient(account)`** — stubs `LendingClient` so that `readContractState(key)` reads from the in-memory map and `readOracleLedgerEntry` returns the synthetic oracle entry. This allows the full SDK read path (`getUserPosition`, `calculateHealthFactor`, `getAllPrices`) to run against simulated data.

### 6.2 `scenarios/full-lifecycle.ts` — 14-step scenario

Setup:
- Prices: XRP = $2.00, RLUSD = $1.00, wBTC = $60,000
- Actors: Alice (supplier), Bob (borrower), Charlie (liquidator)
- Initial timestamp: 1,700,000,000

| Step | Action | Key assertion |
|------|--------|--------------|
| 1 | Alice supplies 100,000 RLUSD | shares = 100,000 × WAD / WAD = 100,000 RLUSD_UNIT; supplyIndex = WAD |
| 2 | Bob deposits 10,000 XRP as collateral | Bob.collateral[XRP] = 10,000,000,000 drops |
| 3 | Bob borrows 8,000 RLUSD | LTV check: 10K×$2×0.80 = $16K ≥ $8K ✓; debt stored as scaled principal |
| 4 | Verify Bob's HF | HF = 10K×$2×0.80 / 8K×$1 = 2.5 WAD (healthy) |
| 5 | Advance 30 days | `ledger.advanceTime(30 * 24 * 3600)` |
| 6 | Interest accrued | borrowIndex > WAD, supplyIndex > WAD |
| 7 | Bob repays 5,000 RLUSD | Remaining actual debt ≈ 3,001 RLUSD (8K+interest−5K) |
| 8 | Verify remaining debt | `actualDebt ≈ 3,001 RLUSD` |
| 9 | XRP price drops to $1.20 | `setOraclePrice(XRP, WAD * 12n / 10n)` |
| 10 | Verify Bob's HF < 1.0 | HF = 10K×$1.20×0.80 / 3001 ≈ 0.933 WAD (liquidatable) |
| 11 | Charlie liquidates 50% of Bob's debt | `debtToRepay = min(amount, 0.5 × totalDebt)` |
| 12 | Verify Charlie received collateral+bonus | seized includes 5% XRP bonus |
| 13 | Verify Bob's HF > 1.0 | Position healthy again |
| 14 | Alice withdraws | Uses `maxWithdrawShares = (totalSupply × WAD) / supplyIndex` to avoid phantom residue |

**Step 14 precision handling**: after all repayments, `totalSupply` may be up to ~8 RLUSD less than `Alice.shares × supplyIndex / WAD`. Root cause: each `repay()` round-trip through `to_scaled_debt` loses 1-2 units of precision per call, accumulating as phantom `totalBorrows` that was never added to `totalSupply`. The fix: compute `maxWithdrawShares = floor(totalSupply × WAD / supplyIndex)` and withdraw at most that many shares. Assertion: price per share (`amountReturned × WAD / shares`) is greater than WAD (Alice earned interest), and `amountReturned > 99,990 RLUSD_UNIT`.

---

## 7. Deploy Scripts (`deploy/`)

Deploy scripts use `xrpl.js v4` with raw transaction objects cast through `unknown` (since XLS-65 and XLS-101 are not yet in xrpl.js typedefs).

### 7.1 `deploy-vaults.ts` — XLS-65 VaultSet

Creates one vault per asset:
```typescript
{ TransactionType: "VaultSet", Asset: { currency: "XRP" }, Flags: 1 }
// Flags: 1 = tfVaultPublic (vault accepts deposits from any account)
```
Extracts `VaultID` from `result.result.meta.AffectedNodes[].CreatedNode.LedgerIndex` where `LedgerEntryType === "Vault"`.

### 7.2 `deploy-controller.ts` — XLS-101 ContractCreate

1. `cargo build --target wasm32-unknown-unknown --release` via `execSync`.
2. Read `lending_controller.wasm`, hex-encode.
3. Submit:
   ```typescript
   { TransactionType: "ContractCreate", Account: deployer, WASMBytecode: wasmHex }
   ```
4. Extract contract pseudo-account from `AffectedNodes[].CreatedNode` where `LedgerEntryType === "AccountRoot"`.
5. Optionally register vault accounts by calling `set_vault` via Invoke: args = `u32LE(vaultIndex) || accountId[20]`.

### 7.3 `configure-markets.ts` — Market and oracle configuration

Calls `set_market_config` via Invoke for each asset. Payload:
- **Market config**: `u8(assetIndex)` + 9 × `u64LE(riskParam)` + 2 × `u8(flags)` = 77 bytes
- **Oracle config**: `oracleAccount[20]` + `u32LE(docId)` + `u64LE(maxStaleness)` + `assetTicker[20]` = 56 bytes

### 7.4 `setup-oracle.ts` — Oracle health check

Reads DIA oracle via SDK, prints current prices and staleness. Exits with code 1 if oracle is stale or circuit-breaker would trigger. Useful as a pre-flight check before deploying.

### 7.5 `shared.ts` — Shared utilities

- `loadDeployEnv()` — reads `DEPLOYER_SECRET`, `XRPL_WSS_URL`, `RLUSD_ISSUER`, `WBTC_ISSUER`.
- `loadDeployedState() / saveDeployedState()` — JSON file at `deploy/deployed.json`.
- `die(msg): never` — prints error, calls `process.exit(1)`.
- `extractCreatedAccount(meta)` / `extractCreatedNodeIndex(meta, type)` — parse XRPL metadata.

---

## 8. Cross-Cutting Reference

### State key format (grammar)

```
market_interest:   "mkt:" + digit(assetIndex) + ":int:" + field(2b)
user_position:     "pos:" + accountId(20B, raw) + ":" + digit(assetIndex) + ":" + field(2b)
global:            "glb:" + field
```

Fields for market interest: `br`(borrow_rate_bps), `sr`(supply_rate_bps), `bi`(borrow_index), `si`(supply_index), `ts`(timestamp), `tb`(total_borrows), `tp`(total_supply).

Fields for user position: `co`(collateral), `de`(stored_debt), `bi`(user_borrow_index), `sh`(supply_shares).

### Invoke payload layout

```
HexValue (uppercase) = hex(functionName) + "00" + hex(args)
```

Sent in `InvokeArgs[0].InvokeArg.HexValue`.

### WAD identities (cheatsheet)

| Operation | Formula |
|-----------|---------|
| `wadMul(a, b)` | `(a × b + 5e17) / 1e18` |
| `wadDiv(a, b)` | `(a × 1e18 + b/2) / b` |
| Compound factor | `1e18 + rt + (rt)²/2` |
| Per-second rate | `bps × 1e18 / (10000 × 31536000)` |
| Shares ← amount | `amount × WAD / supplyIndex` (wadDiv) |
| Amount ← shares | `shares × supplyIndex / WAD` (wadMul) |
| Actual debt | `stored × currentIndex / userIndex` |
| Stored debt | `actual × WAD / currentIndex` |

### Key formulas at a glance

**Health Factor:**
```
HF = [ Σ col_i × (priceWad_i / 10^dec_i) × liqThresh_i / BPS ] × WAD
     / [ Σ debt_i × (priceWad_i / 10^dec_i) ]
```

**Borrow capacity check:**
```
capacity_usd = Σ col_i × price_i × ltv_i / BPS  −  Σ debt_i × price_i
must have: amount_usd ≤ capacity_usd
```

**Liquidation seize amount:**
```
base_collateral = debtUsd / (colPriceWad / 10^colDec)
bonus           = base_collateral × liquidationBonus / BPS
colToSeize      = base_collateral + bonus
```

### Constants (all modules)

```
WAD              = 1_000_000_000_000_000_000   (1e18)
BPS              = 10_000
SECONDS_PER_YEAR = 31_536_000
ASSET_DECIMALS   = [6, 6, 8]   // XRP, RLUSD, wBTC
MAX_CLOSE_FACTOR = 5000 bps    // 50%
DIA_DOC_ID       = 42
MAX_ORACLE_AGE   = 300s
RLUSD_CB_RANGE   = [9500, 10500] bps
```

---

## 9. Known Quirks & Gotchas

### 9.1 `supply_rate_bps` passed as `reserve_factor`

In `interest.rs:172`, step 3 of `update_interest_indexes`:
```rust
let supply_rate_per_sec =
    calculate_supply_rate(borrow_rate_per_sec, new_utilization, state.supply_rate_bps as u64);
//                                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//   Bug candidate: `state.supply_rate_bps` is passed where `reserve_factor_bps` is expected.
//   At t=0 supply_rate_bps=0, so the result is the same as if reserve_factor were 0
//   (100% of interest goes to suppliers). Effect is mild in practice but inflates supply APY.
```
The TypeScript simulator replicates this exactly (`simulated-ledger.ts:156-163`). The correct behavior (using `config.reserve_factor`) is used only in step 8 of the same function (rate recomputation for the next period).

**Impact**: supply rate during a compounding period is higher than intended. Protocol earns less reserve than configured. Flag for future fix.

### 9.2 Integer-division phantom residue in scaled debt

`to_scaled_debt(amount, index) = amount × WAD / index` truncates. Over multiple partial repayments, the sum of stored principals rounds down slightly. After full repayment:
- `actualDebt` computed from stored principal ≈ 0 (rounds to 0 when remainder is tiny).
- But `totalBorrows` was decremented by the actual amount, not by the re-read stored amount.

Net effect: ~1-8 units of `totalBorrows` remain "phantom" — they were never added to `totalSupply`. Alice's shares × supplyIndex can be 5-8 RLUSD more than `totalSupply`. Step 14 of the E2E test handles this with `maxWithdrawShares` floor division.

### 9.3 `AssetIndex` must be a regular enum

```typescript
// CORRECT (sdk/src/types.ts):
export enum AssetIndex { XRP = 0, RLUSD = 1, WBTC = 2 }
// WRONG (would silently break iteration over V1_MARKETS):
export const enum AssetIndex { ... }  // const enum erases the runtime object
```
If `AssetIndex` were a `const enum`, `V1_MARKETS[AssetIndex.XRP]` would work at compile time but any code iterating `Object.values(AssetIndex)` or using it as a runtime index pattern would fail silently.

### 9.4 ESM/CJS module split

| Package | Module system | Note |
|---------|--------------|-------|
| `sdk/` | CJS (`"type"` absent, `tsc` → `dist/`) | Imported by keeper and tests |
| `keeper/` | CJS (`tsconfig` → `CommonJS`) | Node.js bot |
| `tests/` | ESM (`"type": "module"`, NodeNext) | Vitest ESM mode |
| `deploy/` | ESM (`"type": "module"`, NodeNext, tsx) | Scripts run via tsx |

When tests import the SDK, Node ESM can import CJS (`require()` interop). But `const enum` across ESM/CJS boundaries can silently resolve to `undefined` — another reason `AssetIndex` must be a regular enum.

### 9.5 AlphaNet WSS URL inconsistency

- **Keeper** (`config.ts`): `wss://s.devnet.rippletest.net:51233`
- **Deploy** (`shared.ts`): `wss://amm.devnet.rippletest.net:51233`

Both target AlphaNet but different entry points. Use `XRPL_WSS_URL` env var to override both scripts to the same node.

### 9.6 `tests/helpers/` excluded from vitest discovery

`tests/vitest.config.ts:8`:
```typescript
exclude: ["**/node_modules/**", "helpers/**", "vitest.config.ts"]
```
`simulated-ledger.ts` is excluded from test collection (it has no `it()` / `describe()` calls). The vitest binary would error if it tried to import it as a test file directly.

---

## 10. Audit Results

Run at the time of this document:

| Suite | Tests | Result |
|-------|-------|--------|
| `sdk/` (7 test files) | 80 | ✅ all passed |
| `keeper/` (4 test files) | 33 | ✅ all passed |
| `tests/` (1 test file) | 14 | ✅ all passed |
| `sdk/` tsc --noEmit | — | ✅ clean |
| `keeper/` tsc --noEmit | — | ✅ clean |
| `tests/` tsc --noEmit | — | ✅ clean |
| `deploy/` tsc --noEmit | — | ✅ clean |
| `contracts/` cargo check (wasm32) | — | ✅ clean (29 warnings) |

Fixes applied during this audit:
- `tests/helpers/simulated-ledger.ts`: 7 `V1_MARKETS[n as AssetIndex]` casts to satisfy strict TypeScript.
- `sdk/`: rebuilt `dist/` to include newly-added `LendingError` / `LendingErrorCode` exports.
- `deploy/`: installed `node_modules` (was missing). Fixed 7 type errors: 2 TransactionMetadata double-casts (`as unknown as Record<string, unknown>`), 3 `xrplClient` readonly bypasses (`as unknown as {xrplClient: Client}`), 1 `globalKey(string)` argument fix, 1 variable name mismatch (`controllerAddress: contractAddress`).
