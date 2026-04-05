/// Interest rate model — kinked two-slope curve (Aave v3 style).
///
/// # Arithmetic conventions
///
/// - Amounts : native ledger units (drops for XRP, satoshis for wBTC, etc.)
/// - Rates   : WAD-scaled per-second (annual_bps / (BPS × SECONDS_PER_YEAR) × WAD)
/// - Indices : WAD-scaled cumulative factor, start at WAD (= 1.0)
/// - Utilization: WAD-scaled fraction 0..WAD (0%..100%)
///
/// # Kinked rate model
///
///   If U ≤ U_opt:
///     borrow_rate_bps = base + (U / U_opt) × slope1
///
///   If U > U_opt:
///     borrow_rate_bps = base + slope1 + ((U - U_opt) / (1 - U_opt)) × slope2
///
/// Supply rate:
///   supply_rate = borrow_rate × U × (1 - reserve_factor)
///
/// Interest accrual (Taylor 2-term compound):
///   compound_factor = 1 + rate×t + (rate×t)²/2    (WAD-scaled)
///   new_index       = old_index × compound_factor / WAD
///   actual_debt     = principal × current_index / user_index

use crate::errors::{LendingError, LendingResult};
use crate::math::{
    annual_bps_to_per_second_wad, calculate_compound_interest, wad_mul, BPS, SECONDS_PER_YEAR, WAD,
};
use crate::state::{InterestState, MarketConfig};

// ── Utilization ───────────────────────────────────────────────────────────────

/// Returns utilization as a WAD-scaled fraction: total_borrows / (total_borrows + total_supply).
///
/// # Arguments
/// Both arguments are in native ledger units (not WAD-scaled).
///
/// # Returns
/// 0 when supply = 0 (no liquidity), WAD when all liquidity is borrowed.
pub fn calculate_utilization(total_borrows: u128, total_supply: u128) -> u128 {
    let denominator = total_borrows.saturating_add(total_supply);
    if denominator == 0 {
        return 0;
    }
    // total_borrows × WAD — safe for protocol-scale amounts:
    //   XRP max 1e17 drops × WAD 1e18 = 1e35 < u128::MAX ✓
    total_borrows.saturating_mul(WAD) / denominator
}

// ── Borrow rate ───────────────────────────────────────────────────────────────

/// Computes the annual borrow rate in BPS from utilization and market config.
/// Internal helper — returns basis points (0..60_400 for extreme slopes).
fn borrow_rate_annual_bps(utilization_wad: u128, config: &MarketConfig) -> u64 {
    // Convert optimal_utilization (BPS) to WAD-scaled threshold
    let optimal_wad = config.optimal_utilization as u128 * WAD / BPS;

    if utilization_wad <= optimal_wad {
        // Below kink: base + (U / U_opt) × slope1
        // = base + utilization_wad × slope1 / optimal_wad
        //
        // Overflow: utilization_wad × slope1 ≤ WAD × 30000 = 3e22 < u128::MAX ✓
        if optimal_wad == 0 {
            return config.base_rate;
        }
        let slope_contribution = utilization_wad * config.slope1 as u128 / optimal_wad;
        (config.base_rate as u128 + slope_contribution) as u64
    } else {
        // Above kink: base + slope1 + ((U - U_opt) / (1 - U_opt)) × slope2
        let excess_util = utilization_wad - optimal_wad;
        let max_excess = WAD - optimal_wad; // > 0 since optimal_wad < WAD (validated)

        // Overflow: excess_util × slope2 ≤ WAD × 30000 = 3e22 < u128::MAX ✓
        let excess_contribution = excess_util * config.slope2 as u128 / max_excess;

        (config.base_rate as u128
            + config.slope1 as u128
            + excess_contribution) as u64
    }
}

/// Computes the borrow rate as a **per-second WAD value** (the unit used by
/// `calculate_compound_interest`).
///
/// # Arguments
/// - `utilization_wad`: 0..WAD, from `calculate_utilization`
/// - `config`: market risk parameters
///
/// # Returns
/// Per-second WAD rate (e.g. 4% APY → ≈1_268_391_679)
pub fn calculate_borrow_rate(utilization_wad: u128, config: &MarketConfig) -> u128 {
    annual_bps_to_per_second_wad(borrow_rate_annual_bps(utilization_wad, config) as u128)
}

// ── Supply rate ───────────────────────────────────────────────────────────────

/// Computes the supply rate as a **per-second WAD value**.
///
/// supply_rate = borrow_rate × utilization × (1 − reserve_factor)
///
/// # Overflow analysis
/// borrow_rate_per_sec (max ≈9.5e9) × utilization_wad (max WAD = 1e18) = 9.5e27 < u128::MAX ✓
pub fn calculate_supply_rate(
    borrow_rate_per_sec: u128,
    utilization_wad: u128,
    reserve_factor_bps: u64,
) -> u128 {
    if utilization_wad == 0 || borrow_rate_per_sec == 0 {
        return 0;
    }
    // Step 1: borrow_rate × utilization (still per-second WAD, scaled down by WAD)
    let rate_x_util = borrow_rate_per_sec.saturating_mul(utilization_wad) / WAD;

    // Step 2: × (1 − reserve_factor)
    let one_minus_rf = BPS - reserve_factor_bps as u128;
    rate_x_util.saturating_mul(one_minus_rf) / BPS
}

// ── Index accrual ─────────────────────────────────────────────────────────────

/// Accrues interest since `state.last_update_timestamp` and returns the updated state.
///
/// This must be called before every user action (supply, borrow, repay, liquidate)
/// to ensure indexes are current.
///
/// # Algorithm
/// 1. Compute elapsed seconds.
/// 2. Use the **stored** borrow rate for the period (rate was set on the last update).
/// 3. Compute compound factor and update indexes.
/// 4. Recompute rates based on new utilization (after interest accrual adds to borrows).
/// 5. Store updated state.
///
/// # Arguments
/// - `state`: current market interest state
/// - `config`: static market parameters (needed to recompute rate after accrual)
/// - `current_timestamp`: ledger time in seconds (get_parent_ledger_time in production)
pub fn update_interest_indexes(
    state: InterestState,
    config: &MarketConfig,
    current_timestamp: u64,
) -> LendingResult<InterestState> {
    let time_elapsed = current_timestamp.saturating_sub(state.last_update_timestamp) as u128;

    if time_elapsed == 0 {
        return Ok(state);
    }

    // ── 1. Accrue borrow index ───────────────────────────────────────────────
    let borrow_rate_per_sec = annual_bps_to_per_second_wad(state.borrow_rate_bps as u128);

    let borrow_compound = calculate_compound_interest(borrow_rate_per_sec, time_elapsed)
        .ok_or(LendingError::InterestAccrualFailed)?;

    // new_borrow_index = old_index × compound_factor / WAD
    // Overflow: index ≈ WAD = 1e18, compound ≈ WAD → product ≈ 1e36 < u128::MAX ✓
    let new_borrow_index = wad_mul(state.borrow_index, borrow_compound)
        .ok_or(LendingError::InterestAccrualFailed)?;

    // ── 2. Accrue borrow principal ───────────────────────────────────────────
    // interest_accrued (native units) = total_borrows × (compound - 1)
    // = wad_mul(borrows_native, growth_wad)
    // growth_wad = borrow_compound - WAD  (the fractional part, WAD-scaled)
    let growth_wad = borrow_compound.saturating_sub(WAD);
    let interest_accrued = wad_mul(state.total_borrows, growth_wad)
        .ok_or(LendingError::InterestAccrualFailed)?;
    let new_total_borrows = state.total_borrows.saturating_add(interest_accrued);

    // ── 3. Accrue supply index ───────────────────────────────────────────────
    let new_utilization = calculate_utilization(new_total_borrows, state.total_supply);
    let supply_rate_per_sec =
        calculate_supply_rate(borrow_rate_per_sec, new_utilization, state.supply_rate_bps as u64);

    // Use supply compound (can be 0 rate → compound = WAD = no change)
    let supply_compound = calculate_compound_interest(supply_rate_per_sec, time_elapsed)
        .ok_or(LendingError::InterestAccrualFailed)?;
    let new_supply_index = wad_mul(state.supply_index, supply_compound)
        .ok_or(LendingError::InterestAccrualFailed)?;

    // ── 4. Recompute rates for next period ───────────────────────────────────
    let new_borrow_rate_bps = borrow_rate_annual_bps(new_utilization, config);
    let new_borrow_rate_per_sec =
        annual_bps_to_per_second_wad(new_borrow_rate_bps as u128);
    let new_supply_rate_bps = supply_rate_annual_bps(new_borrow_rate_per_sec, new_utilization, config.reserve_factor);

    Ok(InterestState {
        borrow_rate_bps: new_borrow_rate_bps,
        supply_rate_bps: new_supply_rate_bps,
        borrow_index: new_borrow_index,
        supply_index: new_supply_index,
        last_update_timestamp: current_timestamp,
        total_borrows: new_total_borrows,
        total_supply: state.total_supply,
    })
}

/// Converts per-second WAD supply rate to annual BPS for storage.
fn supply_rate_annual_bps(
    borrow_rate_per_sec: u128,
    utilization_wad: u128,
    reserve_factor_bps: u64,
) -> u64 {
    let supply_per_sec = calculate_supply_rate(borrow_rate_per_sec, utilization_wad, reserve_factor_bps);
    // annual_bps = supply_per_sec × BPS × SECONDS_PER_YEAR / WAD
    // supply_per_sec ≈ 9.5e9 (at 300% APY), BPS = 1e4, SECONDS_PER_YEAR = 3.15e7
    // 9.5e9 × 1e4 = 9.5e13 — safe; × 3.15e7 = 3e21 < u128::MAX ✓ then / WAD
    (supply_per_sec * BPS * SECONDS_PER_YEAR / WAD) as u64
}

// ── Debt accounting ───────────────────────────────────────────────────────────

/// Computes the actual debt including accrued interest.
///
/// actual_debt = principal × current_borrow_index / user_borrow_index
///
/// # Arguments
/// All index arguments are WAD-scaled and must be non-zero.
///
/// # Overflow analysis
/// principal (max 1e17 native) × current_index (max ≈3×WAD ≈3e18) = 3e35 < u128::MAX ✓
pub fn get_actual_debt(
    principal: u128,
    user_borrow_index: u128,
    current_borrow_index: u128,
) -> LendingResult<u128> {
    if principal == 0 {
        return Ok(0);
    }
    if user_borrow_index == 0 {
        return Err(LendingError::InterestAccrualFailed);
    }
    // principal × current / user — integer arithmetic, rounds down (conservative for borrowers)
    principal
        .checked_mul(current_borrow_index)
        .ok_or(LendingError::MathOverflow)?
        .checked_div(user_borrow_index)
        .ok_or(LendingError::InterestAccrualFailed)
}

/// Returns the normalised principal to store when a user borrows.
/// stored_principal = actual_amount × WAD / current_borrow_index
/// so that get_actual_debt(stored_principal, current_index, future_index) returns future debt.
pub fn to_scaled_debt(amount: u128, current_borrow_index: u128) -> LendingResult<u128> {
    if current_borrow_index == 0 {
        return Err(LendingError::InterestAccrualFailed);
    }
    // amount × WAD / current_index
    // amount (1e17) × WAD (1e18) = 1e35 < u128::MAX ✓
    amount
        .checked_mul(WAD)
        .ok_or(LendingError::MathOverflow)?
        .checked_div(current_borrow_index)
        .ok_or(LendingError::InterestAccrualFailed)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{RLUSD_MARKET, V1_MARKETS, WBTC_MARKET, XRP_MARKET};

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Convert BPS to WAD-scaled utilization
    fn util(bps: u64) -> u128 {
        bps as u128 * WAD / BPS
    }

    /// Read back per-second WAD rate as annual BPS (round-trips through conversion)
    fn rate_to_annual_bps(rate_per_sec: u128) -> u64 {
        (rate_per_sec * BPS * SECONDS_PER_YEAR / WAD) as u64
    }

    fn borrow_rate_bps(utilization_bps: u64, config: &MarketConfig) -> u64 {
        borrow_rate_annual_bps(util(utilization_bps), config)
    }

    // ── calculate_utilization ─────────────────────────────────────────────────

    #[test]
    fn utilization_zero_borrows() {
        assert_eq!(calculate_utilization(0, 1_000_000), 0);
    }

    #[test]
    fn utilization_zero_supply_and_borrows() {
        assert_eq!(calculate_utilization(0, 0), 0);
    }

    #[test]
    fn utilization_all_borrowed() {
        // 100% utilization
        assert_eq!(calculate_utilization(1_000_000, 0), WAD);
    }

    #[test]
    fn utilization_80pct() {
        // 80 borrows, 20 supply → 80/(80+20) = 80%
        let result = calculate_utilization(80_000_000, 20_000_000);
        let expected = util(8000);
        let diff = if result > expected { result - expected } else { expected - result };
        assert!(diff < WAD / 10_000, "utilization diff too large: {}", diff);
    }

    #[test]
    fn utilization_90pct() {
        let result = calculate_utilization(90_000, 10_000);
        assert_eq!(result, util(9000));
    }

    #[test]
    fn utilization_large_native_amounts() {
        // 1e17 drops borrowed, 2.5e16 drops available → 80% util
        let borrows = 100_000_000_000_000_000u128; // 1e17
        let supply = 25_000_000_000_000_000u128;   // 2.5e16
        let result = calculate_utilization(borrows, supply);
        let expected = util(8000);
        let diff = if result > expected { result - expected } else { expected - result };
        assert!(diff < WAD / 10_000, "large amounts utilization off by {}", diff);
    }

    // ── Borrow rate — XRP market ──────────────────────────────────────────────

    #[test]
    fn xrp_rate_at_zero_util() {
        // base = 0, util = 0 → 0 bps
        assert_eq!(borrow_rate_bps(0, &XRP_MARKET), 0);
    }

    #[test]
    fn xrp_rate_at_kink() {
        // util = 80% (optimal) → base + slope1 = 0 + 400 = 400 bps
        assert_eq!(borrow_rate_bps(8000, &XRP_MARKET), 400);
    }

    #[test]
    fn xrp_rate_at_50pct_util() {
        // util = 50%, below kink: 0 + (5000/8000) × 400 = 250 bps
        assert_eq!(borrow_rate_bps(5000, &XRP_MARKET), 250);
    }

    #[test]
    fn xrp_rate_at_90pct_util() {
        // above kink: excess = 10%, max_excess = 20%
        // 0 + 400 + (1000/2000) × 30000 = 400 + 15000 = 15400 bps
        assert_eq!(borrow_rate_bps(9000, &XRP_MARKET), 15400);
    }

    #[test]
    fn xrp_rate_at_100pct_util() {
        // max: base + slope1 + slope2 = 0 + 400 + 30000 = 30400 bps
        assert_eq!(borrow_rate_bps(10000, &XRP_MARKET), 30400);
    }

    #[test]
    fn xrp_rate_monotone() {
        // Rate must be non-decreasing as utilization increases
        let utils = [0u64, 2000, 4000, 6000, 8000, 9000, 9500, 10000];
        let rates: Vec<u64> = utils.iter()
            .map(|&u| borrow_rate_bps(u, &XRP_MARKET))
            .collect();
        for w in rates.windows(2) {
            assert!(w[0] <= w[1], "rate not monotone: {} > {} at consecutive utils", w[0], w[1]);
        }
    }

    // ── Borrow rate — RLUSD market ────────────────────────────────────────────

    #[test]
    fn rlusd_rate_at_zero_util() {
        assert_eq!(borrow_rate_bps(0, &RLUSD_MARKET), 0);
    }

    #[test]
    fn rlusd_rate_at_kink() {
        // optimal = 90%, slope1 = 400 bps
        assert_eq!(borrow_rate_bps(9000, &RLUSD_MARKET), 400);
    }

    #[test]
    fn rlusd_rate_at_45pct_util() {
        // 50% of optimal: 0 + (4500/9000) × 400 = 200 bps
        assert_eq!(borrow_rate_bps(4500, &RLUSD_MARKET), 200);
    }

    #[test]
    fn rlusd_rate_at_95pct_util() {
        // excess = 5%, max_excess = 10%: 0 + 400 + (500/1000) × 6000 = 400 + 3000 = 3400
        assert_eq!(borrow_rate_bps(9500, &RLUSD_MARKET), 3400);
    }

    #[test]
    fn rlusd_rate_at_100pct_util() {
        // 0 + 400 + 6000 = 6400 bps
        assert_eq!(borrow_rate_bps(10000, &RLUSD_MARKET), 6400);
    }

    #[test]
    fn rlusd_much_softer_than_xrp_above_kink() {
        // At 100% util: RLUSD 6400 bps vs XRP 30400 bps — stablecoin is gentler
        assert!(borrow_rate_bps(10000, &RLUSD_MARKET) < borrow_rate_bps(10000, &XRP_MARKET));
    }

    // ── Borrow rate — wBTC market ─────────────────────────────────────────────

    #[test]
    fn wbtc_rate_at_zero_util() {
        assert_eq!(borrow_rate_bps(0, &WBTC_MARKET), 0);
    }

    #[test]
    fn wbtc_rate_at_kink() {
        // optimal = 45%, slope1 = 700 bps
        assert_eq!(borrow_rate_bps(4500, &WBTC_MARKET), 700);
    }

    #[test]
    fn wbtc_rate_at_22pct_util() {
        // ≈50% of optimal: 0 + (2250/4500) × 700 = 350 bps
        assert_eq!(borrow_rate_bps(2250, &WBTC_MARKET), 350);
    }

    #[test]
    fn wbtc_rate_above_kink() {
        // util = 72.5%: excess = 27.5%, max_excess = 55%
        // 0 + 700 + (2750/5500) × 30000 = 700 + 15000 = 15700 bps
        assert_eq!(borrow_rate_bps(7250, &WBTC_MARKET), 15700);
    }

    #[test]
    fn wbtc_rate_at_100pct_util() {
        // 0 + 700 + 30000 = 30700 bps
        assert_eq!(borrow_rate_bps(10000, &WBTC_MARKET), 30700);
    }

    #[test]
    fn wbtc_kink_hits_earlier_than_xrp() {
        // wBTC kink at 45%, XRP kink at 80%
        // At 60% util, wBTC is already deep in slope2 territory, XRP is still in slope1
        let rate_wbtc_60 = borrow_rate_bps(6000, &WBTC_MARKET);
        let rate_xrp_60 = borrow_rate_bps(6000, &XRP_MARKET);
        assert!(rate_wbtc_60 > rate_xrp_60,
            "wBTC {rate_wbtc_60} should be > XRP {rate_xrp_60} at 60% util");
    }

    // ── Supply rate ───────────────────────────────────────────────────────────

    #[test]
    fn supply_rate_zero_when_util_zero() {
        let borrow_rate = calculate_borrow_rate(util(8000), &XRP_MARKET);
        assert_eq!(calculate_supply_rate(borrow_rate, 0, 2000), 0);
    }

    #[test]
    fn supply_rate_zero_when_borrow_rate_zero() {
        assert_eq!(calculate_supply_rate(0, util(5000), 2000), 0);
    }

    #[test]
    fn supply_rate_at_xrp_kink() {
        // XRP: util=80%, borrow=4%, reserve_factor=20%
        // supply = 4% × 80% × 80% = 2.56% APY
        let borrow_per_sec = calculate_borrow_rate(util(8000), &XRP_MARKET);
        let supply_per_sec = calculate_supply_rate(borrow_per_sec, util(8000), XRP_MARKET.reserve_factor as u64);
        let supply_bps = rate_to_annual_bps(supply_per_sec);
        // Expected 256 bps (2.56%) — allow ±2 bps rounding
        assert!((supply_bps as i64 - 256).abs() <= 2,
            "XRP supply rate at kink: expected ≈256 bps, got {supply_bps}");
    }

    #[test]
    fn supply_rate_below_borrow_rate() {
        // Supply rate must always be ≤ borrow rate (reserve factor takes the spread)
        for config in &V1_MARKETS {
            for util_bps in [0u64, 2500, 5000, 7500, 10000] {
                let u = util(util_bps);
                let br = calculate_borrow_rate(u, config);
                let sr = calculate_supply_rate(br, u, config.reserve_factor as u64);
                assert!(sr <= br,
                    "supply_rate > borrow_rate at {util_bps} bps util for asset {}",
                    config.asset_index);
            }
        }
    }

    #[test]
    fn supply_rate_rlusd_at_kink() {
        // RLUSD: util=90%, borrow=4%, RF=10%
        // supply = 4% × 90% × 90% = 3.24%
        let borrow_per_sec = calculate_borrow_rate(util(9000), &RLUSD_MARKET);
        let supply_per_sec = calculate_supply_rate(borrow_per_sec, util(9000), RLUSD_MARKET.reserve_factor as u64);
        let supply_bps = rate_to_annual_bps(supply_per_sec);
        assert!((supply_bps as i64 - 324).abs() <= 2,
            "RLUSD supply at kink: expected ≈324 bps, got {supply_bps}");
    }

    // ── Index accrual ─────────────────────────────────────────────────────────

    fn make_state(total_borrows: u128, total_supply: u128, borrow_rate_bps: u64, ts: u64) -> InterestState {
        InterestState {
            borrow_rate_bps,
            supply_rate_bps: 0,
            borrow_index: WAD,
            supply_index: WAD,
            last_update_timestamp: ts,
            total_borrows,
            total_supply,
        }
    }

    #[test]
    fn no_elapsed_time_returns_unchanged_state() {
        let state = make_state(80_000, 20_000, 400, 1_000_000);
        let updated = update_interest_indexes(state, &XRP_MARKET, 1_000_000).unwrap();
        assert_eq!(updated.borrow_index, state.borrow_index);
        assert_eq!(updated.supply_index, state.supply_index);
        assert_eq!(updated.total_borrows, state.total_borrows);
    }

    #[test]
    fn index_increases_after_one_hour() {
        // 4% APY, 80% utilization, 1 hour elapsed
        let state = make_state(80_000_000, 20_000_000, 400, 0);
        let updated = update_interest_indexes(state, &XRP_MARKET, 3600).unwrap();

        // Index must increase
        assert!(updated.borrow_index > WAD, "borrow_index should exceed WAD after accrual");
        // Approximately: 4% / 8760h ≈ 0.000456% per hour → index ≈ WAD + 4.56e12
        // Allow 10% tolerance for Taylor approximation
        let expected_growth = WAD / (100 * 8760); // 1/(8760 * 100) ≈ 1.14e12
        assert!(updated.borrow_index > WAD + expected_growth / 2,
            "borrow_index grew less than expected: {}", updated.borrow_index - WAD);
    }

    #[test]
    fn index_increases_monotonically() {
        let state = make_state(80_000_000, 20_000_000, 400, 0);
        let after_1h = update_interest_indexes(state, &XRP_MARKET, 3_600).unwrap();
        let after_1d = update_interest_indexes(state, &XRP_MARKET, 86_400).unwrap();
        let after_1w = update_interest_indexes(state, &XRP_MARKET, 604_800).unwrap();

        assert!(after_1h.borrow_index < after_1d.borrow_index,
            "1h index should < 1d index");
        assert!(after_1d.borrow_index < after_1w.borrow_index,
            "1d index should < 1w index");
    }

    #[test]
    fn total_borrows_increase_after_accrual() {
        let state = make_state(80_000_000, 20_000_000, 400, 0);
        let updated = update_interest_indexes(state, &XRP_MARKET, 86_400).unwrap(); // 1 day
        assert!(updated.total_borrows > state.total_borrows,
            "total_borrows must increase after accrual");
    }

    #[test]
    fn index_after_one_year_4pct() {
        // At exactly optimal utilization, XRP borrow rate = 4% APY
        let state = make_state(80_000_000, 20_000_000, 400, 0);
        let updated = update_interest_indexes(state, &XRP_MARKET, SECONDS_PER_YEAR as u64).unwrap();

        // Expected index ≈ WAD × 1.0408 (2-term Taylor for e^0.04)
        // Actual e^0.04 ≈ 1.04081
        let expected_low = WAD + WAD * 400 / 10000;       // 1.04 WAD (linear approx)
        let expected_high = WAD + WAD * 420 / 10000;      // 1.042 WAD (above 2-term Taylor)
        assert!(
            updated.borrow_index >= expected_low && updated.borrow_index <= expected_high,
            "1-year 4% index {} not in [{}, {}]",
            updated.borrow_index, expected_low, expected_high
        );
    }

    #[test]
    fn zero_borrow_rate_leaves_index_unchanged() {
        // 0% util → 0% rate → index stays at WAD
        let state = make_state(0, 100_000_000, 0, 0);
        let updated = update_interest_indexes(state, &XRP_MARKET, 86_400).unwrap();
        assert_eq!(updated.borrow_index, WAD);
        assert_eq!(updated.supply_index, WAD);
    }

    #[test]
    fn supply_index_increases_with_borrow_index() {
        // When utilization > 0, supply index should also grow (slower)
        let state = make_state(80_000_000, 20_000_000, 400, 0);
        let updated = update_interest_indexes(state, &XRP_MARKET, 604_800).unwrap(); // 1 week
        assert!(updated.supply_index >= WAD, "supply_index must not decrease");
    }

    // ── get_actual_debt ───────────────────────────────────────────────────────

    #[test]
    fn actual_debt_no_interest() {
        // If current_index == user_index, debt is unchanged
        let principal = 1_000_000u128;
        let index = WAD;
        assert_eq!(get_actual_debt(principal, index, index).unwrap(), principal);
    }

    #[test]
    fn actual_debt_doubles_when_index_doubles() {
        let principal = 1_000_000u128;
        let user_index = WAD;
        let current_index = 2 * WAD;
        assert_eq!(get_actual_debt(principal, user_index, current_index).unwrap(), 2_000_000);
    }

    #[test]
    fn actual_debt_after_4pct_one_year() {
        // Index grows by ≈4.08% for 4% APY compounded
        // principal = 100_000 drops
        let principal = 100_000u128;
        let user_index = WAD;
        let current_index = WAD + WAD * 408 / 10000; // ≈1.0408 WAD

        let actual = get_actual_debt(principal, user_index, current_index).unwrap();
        // Expected ≈104_080
        assert!(actual >= 104_000 && actual <= 105_000,
            "actual debt {} not in expected range", actual);
    }

    #[test]
    fn actual_debt_zero_principal() {
        assert_eq!(get_actual_debt(0, WAD, WAD * 2).unwrap(), 0);
    }

    #[test]
    fn actual_debt_zero_user_index_is_error() {
        assert!(get_actual_debt(1000, 0, WAD).is_err());
    }

    #[test]
    fn actual_debt_current_below_user_index_decreases() {
        // Shouldn't happen in practice, but if current < user (index decreases), debt decreases
        let principal = 1_000_000u128;
        let actual = get_actual_debt(principal, 2 * WAD, WAD).unwrap();
        assert_eq!(actual, 500_000);
    }

    // ── to_scaled_debt ────────────────────────────────────────────────────────

    #[test]
    fn scaled_debt_roundtrip() {
        // Borrow 1000 at index WAD, then retrieve at 2×WAD → should get 2000
        let amount = 1_000u128;
        let borrow_index = WAD;
        let scaled = to_scaled_debt(amount, borrow_index).unwrap();
        // At WAD index, scaled == amount
        assert_eq!(scaled, amount);

        // At a later index (2×WAD)
        let retrieved = get_actual_debt(scaled, borrow_index, 2 * WAD).unwrap();
        assert_eq!(retrieved, 2 * amount);
    }

    #[test]
    fn scaled_debt_precision() {
        // Borrow at index 1.5 × WAD, retrieve at 2 × WAD
        // principal_stored = amount × WAD / 1.5_WAD = amount × 2/3
        let amount = 3_000u128;
        let borrow_index = WAD + WAD / 2; // 1.5 WAD
        let scaled = to_scaled_debt(amount, borrow_index).unwrap();
        assert_eq!(scaled, 2_000); // 3000 × WAD / (1.5 WAD) = 2000

        let later_index = 2 * WAD;
        let actual = get_actual_debt(scaled, borrow_index, later_index).unwrap();
        // 2000 × 2WAD / 1.5WAD = 2666
        assert_eq!(actual, 2_666);
    }

    #[test]
    fn to_scaled_debt_zero_index_is_error() {
        assert!(to_scaled_debt(1000, 0).is_err());
    }

    // ── Integration: simulate a full borrow-accrue cycle ─────────────────────

    #[test]
    fn simulate_borrow_and_accrue() {
        // Setup: 100M supply, 0 borrows (util = 0, rate = 0)
        let mut state = InterestState::new();
        state.total_supply = 100_000_000u128;
        state.last_update_timestamp = 0;

        // User borrows 80M at t=0 (util = 80%)
        state.total_borrows = 80_000_000;
        state.borrow_rate_bps = borrow_rate_annual_bps(calculate_utilization(80_000_000, 20_000_000), &XRP_MARKET);
        let user_entry_index = state.borrow_index; // WAD

        // 1 year passes
        let updated = update_interest_indexes(state, &XRP_MARKET, SECONDS_PER_YEAR as u64).unwrap();

        // Actual debt of user
        let actual_debt = get_actual_debt(80_000_000, user_entry_index, updated.borrow_index).unwrap();

        // Should be ≈82% of 80M (4% APY for 1 year): 80M × 1.04 = 83.2M
        assert!(actual_debt > 82_000_000 && actual_debt < 85_000_000,
            "actual_debt {} outside expected range [82M, 85M]", actual_debt);

        // Total borrows in state should also reflect accrued interest
        assert!(updated.total_borrows > 80_000_000,
            "total_borrows not updated: {}", updated.total_borrows);
    }
}
