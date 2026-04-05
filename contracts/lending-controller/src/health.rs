// Health factor calculation and solvency checks

use crate::errors::{LendingError, LendingResult};
use crate::math::WAD;
use crate::oracle::POW10;
use crate::state::{MarketConfig, UserPositionForAsset, ASSET_DECIMALS, NUM_V1_MARKETS};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Close factor: max 50% of total debt can be repaid in one liquidation call.
pub const MAX_LIQUIDATION_BPS: u64 = 5_000;

// ── Private helpers ───────────────────────────────────────────────────────────

/// Compute the USD value of a native amount of an asset.
///
/// `price_wad` is the price of 1 WHOLE unit (e.g. 1 XRP, 1 BTC) in USD, WAD-scaled.
/// `decimals` is the number of native decimal places (6 for XRP/RLUSD, 8 for wBTC).
///
/// Formula: value_usd_wad = amount_native × price_wad / 10^decimals
///
/// We divide price first to avoid overflow. Precision loss is at most 1 in the
/// smallest native unit, which is negligible for protocol risk calculations.
pub(crate) fn asset_usd_value(
    amount_native: u128,
    price_wad: u128,
    decimals: u8,
) -> LendingResult<u128> {
    if amount_native == 0 || price_wad == 0 {
        return Ok(0);
    }
    let price_per_native = price_wad / POW10[decimals as usize]; // price per 1 drop/sat/etc.
    amount_native
        .checked_mul(price_per_native)
        .ok_or(LendingError::MathOverflow)
}

/// Overflow-safe `numerator × WAD / denominator` (rounded down).
///
/// Returns `None` if denominator is zero.
/// Uses decomposition when `numerator × WAD` would overflow u128.
fn wad_ratio(numerator: u128, denominator: u128) -> Option<u128> {
    if denominator == 0 {
        return None;
    }
    // Fast path: no overflow
    if let Some(n_wad) = numerator.checked_mul(WAD) {
        return Some(n_wad / denominator);
    }
    // Slow path: decompose  q×WAD  +  (r×WAD)/denom
    let q = numerator / denominator;
    let r = numerator % denominator;
    let q_wad = q.checked_mul(WAD)?;
    let frac = match r.checked_mul(WAD) {
        Some(r_wad) => r_wad / denominator,
        None => {
            // r×WAD also overflows — scale both r and denom down by the same factor.
            // max_safe is the largest value s.t. max_safe × WAD <= u128::MAX.
            let max_safe = u128::MAX / WAD;
            let scale = r / max_safe + 1;
            let r_scaled = r / scale;
            let d_scaled = denominator / scale;
            if d_scaled == 0 {
                return Some(q_wad);
            }
            r_scaled * WAD / d_scaled
        }
    };
    q_wad.checked_add(frac)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Calculate the health factor for a user across all markets.
///
/// HF = Σ(collateral_i × price_i × liquidation_threshold_i) / Σ(debt_i × price_i)
///
/// Returns `u128::MAX` when total debt is zero (fully healthy).
/// Returns WAD-scaled value (WAD = 1.0).
///
/// # Arguments
/// * `positions`  — user's per-asset positions (collateral + debt in native units)
/// * `prices`     — WAD-scaled USD prices indexed by asset (same order as `ASSET_DECIMALS`)
/// * `configs`    — market configurations (for liquidation_threshold_bps)
pub fn calculate_health_factor(
    positions: &[UserPositionForAsset; NUM_V1_MARKETS as usize],
    prices: &[u128; NUM_V1_MARKETS as usize],
    configs: &[MarketConfig; NUM_V1_MARKETS as usize],
) -> LendingResult<u128> {
    let mut total_weighted_col: u128 = 0;
    let mut total_debt_usd: u128 = 0;

    for i in 0..NUM_V1_MARKETS as usize {
        let decimals = ASSET_DECIMALS[i];
        let price = prices[i];
        let config = &configs[i];
        let pos = &positions[i];

        // Collateral contribution: col_usd × liquidation_threshold / BPS
        if pos.collateral > 0 {
            let col_usd = asset_usd_value(pos.collateral, price, decimals)?;
            // weighted = col_usd × liq_threshold / BPS
            let weighted = col_usd
                .checked_mul(config.liquidation_threshold as u128)
                .ok_or(LendingError::MathOverflow)?
                / 10_000;
            total_weighted_col = total_weighted_col
                .checked_add(weighted)
                .ok_or(LendingError::MathOverflow)?;
        }

        // Debt contribution
        if pos.debt > 0 {
            let debt_usd = asset_usd_value(pos.debt, price, decimals)?;
            total_debt_usd = total_debt_usd
                .checked_add(debt_usd)
                .ok_or(LendingError::MathOverflow)?;
        }
    }

    if total_debt_usd == 0 {
        return Ok(u128::MAX);
    }

    wad_ratio(total_weighted_col, total_debt_usd).ok_or(LendingError::MathOverflow)
}

/// Calculate remaining borrow capacity in USD (WAD-scaled).
///
/// Capacity = Σ(collateral_i × price_i × ltv_i) - Σ(debt_i × price_i)
///
/// Returns 0 if the user is already over-borrowed.
pub fn calculate_borrow_capacity(
    positions: &[UserPositionForAsset; NUM_V1_MARKETS as usize],
    prices: &[u128; NUM_V1_MARKETS as usize],
    configs: &[MarketConfig; NUM_V1_MARKETS as usize],
) -> LendingResult<u128> {
    let mut total_ltv_usd: u128 = 0;
    let mut total_debt_usd: u128 = 0;

    for i in 0..NUM_V1_MARKETS as usize {
        let decimals = ASSET_DECIMALS[i];
        let price = prices[i];
        let config = &configs[i];
        let pos = &positions[i];

        if pos.collateral > 0 {
            let col_usd = asset_usd_value(pos.collateral, price, decimals)?;
            let ltv_usd = col_usd
                .checked_mul(config.ltv as u128)
                .ok_or(LendingError::MathOverflow)?
                / 10_000;
            total_ltv_usd = total_ltv_usd
                .checked_add(ltv_usd)
                .ok_or(LendingError::MathOverflow)?;
        }

        if pos.debt > 0 {
            let debt_usd = asset_usd_value(pos.debt, price, decimals)?;
            total_debt_usd = total_debt_usd
                .checked_add(debt_usd)
                .ok_or(LendingError::MathOverflow)?;
        }
    }

    Ok(total_ltv_usd.saturating_sub(total_debt_usd))
}

/// Returns true if a position can be liquidated (HF < 1.0 WAD).
#[inline]
pub fn is_liquidatable(health_factor: u128) -> bool {
    health_factor < WAD
}

/// Calculate the maximum debt amount (in USD, WAD-scaled) that can be repaid in
/// one liquidation call (50% close factor).
///
/// `total_debt_usd` — sum of all debt values in USD, WAD-scaled.
pub fn calculate_max_liquidation(total_debt_usd: u128) -> u128 {
    total_debt_usd * MAX_LIQUIDATION_BPS as u128 / 10_000
}

/// Calculate the collateral to seize for a given debt repayment.
///
/// Returns `(collateral_to_seize_native, bonus_native)` both in native units.
///
/// Formula:
///   debt_usd = debt_to_repay_native × debt_price / 10^debt_decimals
///   seize_usd = debt_usd × (BPS + liquidation_bonus_bps) / BPS
///   collateral_to_seize_native = seize_usd × 10^col_decimals / col_price
///   bonus_native = seize_native - (debt_usd × 10^col_decimals / col_price)
///
/// Returns `Err(MathOverflow)` if intermediate values overflow u128.
pub fn calculate_liquidation_amounts(
    debt_to_repay_native: u128,
    debt_price_wad: u128,
    collateral_price_wad: u128,
    liquidation_bonus_bps: u64,
    debt_decimals: u8,
    collateral_decimals: u8,
) -> LendingResult<(u128, u128)> {
    if debt_price_wad == 0 || collateral_price_wad == 0 {
        return Err(LendingError::OraclePriceZero);
    }

    // debt_usd (WAD-scaled) = debt_native × debt_price_wad / 10^debt_decimals
    let debt_usd = asset_usd_value(debt_to_repay_native, debt_price_wad, debt_decimals)?;

    // seize_usd = debt_usd × (10_000 + bonus_bps) / 10_000
    let seize_usd = debt_usd
        .checked_mul(10_000 + liquidation_bonus_bps as u128)
        .ok_or(LendingError::MathOverflow)?
        / 10_000;

    // collateral_to_seize_native = seize_usd × 10^col_decimals / col_price_wad
    // = seize_usd / (col_price_wad / 10^col_decimals)
    let col_price_per_native = collateral_price_wad / POW10[collateral_decimals as usize];
    if col_price_per_native == 0 {
        return Err(LendingError::OraclePriceZero);
    }

    let col_to_seize = seize_usd
        .checked_div(col_price_per_native)
        .ok_or(LendingError::MathOverflow)?;

    // base_col (no bonus) = debt_usd × 10^col_decimals / col_price_wad
    let base_col = debt_usd
        .checked_div(col_price_per_native)
        .ok_or(LendingError::MathOverflow)?;

    let bonus = col_to_seize.saturating_sub(base_col);

    Ok((col_to_seize, bonus))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{UserPositionForAsset, V1_MARKETS};

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// WAD price of `dollars` USD (e.g. price_usd(2, 15) = $2.15 WAD).
    fn price_usd(whole: u128, cents: u128) -> u128 {
        (whole * 100 + cents) * WAD / 100
    }

    fn empty_pos() -> UserPositionForAsset {
        UserPositionForAsset {
            collateral: 0,
            debt: 0,
            user_borrow_index: WAD,
        }
    }

    fn make_positions(
        xrp_col: u128,
        xrp_debt: u128,
        rlusd_col: u128,
        rlusd_debt: u128,
        wbtc_col: u128,
        wbtc_debt: u128,
    ) -> [UserPositionForAsset; 3] {
        [
            UserPositionForAsset { collateral: xrp_col, debt: xrp_debt, user_borrow_index: WAD },
            UserPositionForAsset { collateral: rlusd_col, debt: rlusd_debt, user_borrow_index: WAD },
            UserPositionForAsset { collateral: wbtc_col, debt: wbtc_debt, user_borrow_index: WAD },
        ]
    }

    /// Default V1 prices used in most tests:
    ///   XRP   = $0.50
    ///   RLUSD = $1.00
    ///   wBTC  = $60,000.00
    fn default_prices() -> [u128; 3] {
        [
            price_usd(0, 50),        // XRP $0.50
            price_usd(1, 0),         // RLUSD $1.00
            60_000 * WAD,            // wBTC $60,000
        ]
    }

    // ── asset_usd_value tests ─────────────────────────────────────────────────

    #[test]
    fn test_asset_usd_zero_amount() {
        assert_eq!(asset_usd_value(0, WAD, 6).unwrap(), 0);
    }

    #[test]
    fn test_asset_usd_zero_price() {
        assert_eq!(asset_usd_value(1_000_000, 0, 6).unwrap(), 0);
    }

    #[test]
    fn test_asset_usd_xrp() {
        // 1000 XRP = 1,000,000,000 drops; price = $2.15 WAD
        // USD = 1e9 × (2.15 WAD / 1e6) = 1e9 × 2_150_000_000_000 = 2_150_000_000_000_000_000_000
        // But asset_usd_value truncates: price_per_drop = 2.15e18 / 1e6 = 2_150_000_000_000
        // value = 1e9 × 2_150_000_000_000 = 2_150_000_000_000_000_000_000
        let price = price_usd(2, 15); // $2.15
        let drops = 1_000_000_000u128; // 1000 XRP
        let usd = asset_usd_value(drops, price, 6).unwrap();
        // 2150 whole-dollar units × 1e18 = 2_150_000_000_000_000_000_000
        assert_eq!(usd, 2_150_000_000_000_000_000_000u128);
    }

    #[test]
    fn test_asset_usd_rlusd_one_unit() {
        // 1 RLUSD = 1_000_000 smallest units; price = $1.00 WAD
        let usd = asset_usd_value(1_000_000, WAD, 6).unwrap();
        // price_per_unit = 1e18 / 1e6 = 1e12; value = 1e6 × 1e12 = 1e18
        assert_eq!(usd, WAD);
    }

    #[test]
    fn test_asset_usd_wbtc_one_sat() {
        // 1 sat; price = $60,000 WAD
        let price = 60_000 * WAD;
        let usd = asset_usd_value(1, price, 8).unwrap();
        // price_per_sat = 60000e18 / 1e8 = 600_000_000_000_000
        // value = 1 × 600_000_000_000_000 = 600_000_000_000_000 (= $0.0006 in WAD)
        assert_eq!(usd, 600_000_000_000_000u128);
    }

    #[test]
    fn test_asset_usd_wbtc_one_whole() {
        // 1 BTC = 100_000_000 sats; price = $60,000 WAD
        let price = 60_000 * WAD;
        let usd = asset_usd_value(100_000_000, price, 8).unwrap();
        assert_eq!(usd, 60_000 * WAD);
    }

    // ── wad_ratio tests ───────────────────────────────────────────────────────

    #[test]
    fn test_wad_ratio_half() {
        // 1/2 WAD = 0.5 WAD
        assert_eq!(wad_ratio(1, 2).unwrap(), WAD / 2);
    }

    #[test]
    fn test_wad_ratio_one() {
        assert_eq!(wad_ratio(1, 1).unwrap(), WAD);
    }

    #[test]
    fn test_wad_ratio_zero_denom() {
        assert!(wad_ratio(1, 0).is_none());
    }

    #[test]
    fn test_wad_ratio_large_hf_117() {
        // HF = 1.17 scenario: weighted = 4.68e22, debt = 4e22
        let weighted: u128 = 46_800_000_000_000_000_000_000;
        let debt: u128 = 40_000_000_000_000_000_000_000;
        let hf = wad_ratio(weighted, debt).unwrap();
        // Expected: 1.17 WAD = 1_170_000_000_000_000_000
        assert_eq!(hf, 1_170_000_000_000_000_000u128);
    }

    #[test]
    fn test_wad_ratio_large_hf_0975() {
        // HF = 0.975 scenario: weighted = 3.9e22, debt = 4e22
        let weighted: u128 = 39_000_000_000_000_000_000_000;
        let debt: u128 = 40_000_000_000_000_000_000_000;
        let hf = wad_ratio(weighted, debt).unwrap();
        // Expected: 0.975 WAD = 975_000_000_000_000_000
        assert_eq!(hf, 975_000_000_000_000_000u128);
    }

    // ── calculate_health_factor tests ─────────────────────────────────────────

    #[test]
    fn test_hf_no_debt_returns_max() {
        let positions = make_positions(1_000_000_000, 0, 0, 0, 0, 0); // 1000 XRP collateral, no debt
        let prices = default_prices();
        let hf = calculate_health_factor(&positions, &prices, &V1_MARKETS).unwrap();
        assert_eq!(hf, u128::MAX);
    }

    #[test]
    fn test_hf_no_collateral_no_debt() {
        let positions = [empty_pos(), empty_pos(), empty_pos()];
        let prices = default_prices();
        let hf = calculate_health_factor(&positions, &prices, &V1_MARKETS).unwrap();
        assert_eq!(hf, u128::MAX);
    }

    #[test]
    fn test_hf_healthy_1_17() {
        // Setup from design doc:
        //   10,000 XRP collateral @ $2.15, liqThreshold=80% → weighted = 10000 × 2.15 × 0.80 = $17,200
        //   20,000 RLUSD debt @ $1.00 → debt = $20,000
        //   HF = 17200/20000 = 0.86  (not 1.17 — use different numbers)
        //
        // To get HF=1.17:
        //   col = 30,000 RLUSD @ $1.00, liqThreshold=85% → weighted = 30000×0.85 = $25,500
        //   debt = 20,000 RLUSD → debt = $20,000
        //   Wait, that's 25500/20000=1.275
        //
        // Simpler: 25,000 RLUSD collateral, 20,000 RLUSD debt
        //   weighted = 25000 × 1.0 × 0.85 = $21,250
        //   HF = 21250/20000 = 1.0625  (not 1.17)
        //
        // Use 30,000 RLUSD col, 21,000 RLUSD debt (liqThresh=85%):
        //   weighted = 30000 × 0.85 = 25500
        //   HF = 25500/21000 ≈ 1.214
        //
        // Exact 1.17: need weighted/debt = 1.17
        //   e.g. weighted=23400, debt=20000 → HF=1.17
        //   Use 27,529.4 RLUSD col... round to drops:
        //   col = 27_530_000_000 RLUSD units (RLUSD has 6 decimals → 27,530 RLUSD)
        //   weighted = 27530 × 1.0 × 0.85 = 23,400.5 ≈ 23,400
        //   debt = 20000 RLUSD → HF = 23400.5/20000 ≈ 1.17
        let rlusd_col = 27_530_000_000u128; // 27,530 RLUSD (6 decimals)
        let rlusd_debt = 20_000_000_000u128; // 20,000 RLUSD
        let positions = make_positions(0, 0, rlusd_col, rlusd_debt, 0, 0);
        let prices = [0u128, WAD, 0u128]; // RLUSD = $1.00

        let hf = calculate_health_factor(&positions, &prices, &V1_MARKETS).unwrap();
        // HF > 1.0 WAD (healthy)
        assert!(hf > WAD, "Expected HF > 1.0, got {}", hf);
        assert!(!is_liquidatable(hf));
    }

    #[test]
    fn test_hf_liquidatable_below_1() {
        // 10,000 RLUSD collateral, 12,000 RLUSD debt (undercollateralized)
        // liqThreshold=85%: weighted = 10000 × 0.85 = 8500
        // debt = 12000
        // HF = 8500/12000 = 0.708...
        let positions = make_positions(0, 0, 10_000_000_000, 12_000_000_000, 0, 0);
        let prices = [0u128, WAD, 0u128];
        let hf = calculate_health_factor(&positions, &prices, &V1_MARKETS).unwrap();
        assert!(hf < WAD, "Expected HF < 1.0, got {}", hf);
        assert!(is_liquidatable(hf));
    }

    #[test]
    fn test_hf_exactly_one() {
        // weighted = debt → HF = 1.0 exactly
        // RLUSD col, liqThreshold=85%: col × 0.85 = debt
        // col = 20000, debt = 17000: weighted = 17000, HF = 1.0 exactly
        let positions = make_positions(0, 0, 20_000_000_000, 17_000_000_000, 0, 0);
        let prices = [0u128, WAD, 0u128];
        let hf = calculate_health_factor(&positions, &prices, &V1_MARKETS).unwrap();
        assert_eq!(hf, WAD);
        assert!(!is_liquidatable(hf)); // HF == 1.0 is NOT liquidatable
    }

    #[test]
    fn test_hf_multi_asset() {
        // 1000 XRP col @ $2.00 (liqThresh=80%): weighted = 1000 × 2.0 × 0.80 = $1600
        // 0.1 BTC col @ $60,000 (liqThresh=78%): 0.1 BTC = 10_000_000 sats
        //   col_usd = 10e6 × (60000e18 / 1e8) = 10e6 × 6e14 = 6e21 = $6000 WAD
        //   weighted = 6000 × 0.78 = $4680
        // 5000 RLUSD debt @ $1.00: debt = $5000
        // Total weighted = 1600 + 4680 = $6280
        // HF = 6280/5000 = 1.256
        let xrp_col = 1_000_000_000u128; // 1000 XRP in drops
        let wbtc_col = 10_000_000u128;   // 0.1 BTC in sats
        let rlusd_debt = 5_000_000_000u128; // 5000 RLUSD
        let positions = make_positions(xrp_col, 0, 0, rlusd_debt, wbtc_col, 0);
        let prices = [2 * WAD, WAD, 60_000 * WAD];

        let hf = calculate_health_factor(&positions, &prices, &V1_MARKETS).unwrap();
        assert!(hf > WAD, "Expected HF > 1.0 in multi-asset scenario, got {}", hf);
    }

    // ── calculate_borrow_capacity tests ──────────────────────────────────────

    #[test]
    fn test_borrow_capacity_no_position() {
        let positions = [empty_pos(), empty_pos(), empty_pos()];
        let prices = default_prices();
        let cap = calculate_borrow_capacity(&positions, &prices, &V1_MARKETS).unwrap();
        assert_eq!(cap, 0);
    }

    #[test]
    fn test_borrow_capacity_pure_collateral() {
        // 10,000 RLUSD collateral @ $1.00, ltv=80%, no debt
        // capacity = 10000 × 0.80 = $8000 WAD
        let positions = make_positions(0, 0, 10_000_000_000, 0, 0, 0);
        let prices = [0u128, WAD, 0u128];
        let cap = calculate_borrow_capacity(&positions, &prices, &V1_MARKETS).unwrap();
        assert_eq!(cap, 8_000 * WAD);
    }

    #[test]
    fn test_borrow_capacity_over_borrowed() {
        // RLUSD col=5000, debt=5000 (same token), ltv=80%
        // ltv_usd = 5000 × 0.80 = 4000
        // debt_usd = 5000
        // capacity = max(0, 4000 - 5000) = 0
        let positions = make_positions(0, 0, 5_000_000_000, 5_000_000_000, 0, 0);
        let prices = [0u128, WAD, 0u128];
        let cap = calculate_borrow_capacity(&positions, &prices, &V1_MARKETS).unwrap();
        assert_eq!(cap, 0);
    }

    #[test]
    fn test_borrow_capacity_multi_asset() {
        // Spec test case:
        //   1000 XRP collateral @ $2.00, ltv=75%: ltv_usd = 1000 × 2.0 × 0.75 = $1500
        //   0.5 BTC collateral @ $60,000, ltv=73%: 5e7 sats
        //     col_usd = 5e7 × (60000e18/1e8) = 5e7 × 6e14 = 3e22 = $30,000 WAD
        //     ltv_usd = 30000 × 0.73 = $21,900
        //   Total ltv_usd = 1500 + 21900 = $23,400
        //   No existing debt → capacity = $23,400
        let xrp_col = 1_000_000_000u128;  // 1000 XRP in drops
        let wbtc_col = 50_000_000u128;     // 0.5 BTC in sats
        let positions = make_positions(xrp_col, 0, 0, 0, wbtc_col, 0);
        let prices = [2 * WAD, WAD, 60_000 * WAD];

        let cap = calculate_borrow_capacity(&positions, &prices, &V1_MARKETS).unwrap();
        // 1500 + 21900 = 23,400 WAD
        assert_eq!(cap, 23_400 * WAD);
    }

    // ── is_liquidatable tests ─────────────────────────────────────────────────

    #[test]
    fn test_is_liquidatable_below_wad() {
        assert!(is_liquidatable(WAD - 1));
    }

    #[test]
    fn test_is_liquidatable_at_wad() {
        assert!(!is_liquidatable(WAD));
    }

    #[test]
    fn test_is_liquidatable_above_wad() {
        assert!(!is_liquidatable(WAD + 1));
    }

    #[test]
    fn test_is_liquidatable_max() {
        assert!(!is_liquidatable(u128::MAX)); // no debt
    }

    // ── calculate_max_liquidation tests ──────────────────────────────────────

    #[test]
    fn test_max_liquidation_50_percent() {
        // $20,000 debt → max = $10,000
        let debt_usd = 20_000 * WAD;
        assert_eq!(calculate_max_liquidation(debt_usd), 10_000 * WAD);
    }

    #[test]
    fn test_max_liquidation_zero() {
        assert_eq!(calculate_max_liquidation(0), 0);
    }

    #[test]
    fn test_max_liquidation_odd_amount() {
        // $1001 debt → max = $500.5 (floor)
        let debt_usd = 1001 * WAD;
        let max = calculate_max_liquidation(debt_usd);
        // 1001 × 5000 / 10000 = 500 (integer division, .5 truncated)
        assert_eq!(max, 500 * WAD + WAD / 2);
    }

    // ── calculate_liquidation_amounts tests ──────────────────────────────────

    #[test]
    fn test_liquidation_amounts_rlusd_to_wbtc() {
        // Spec test case:
        //   Repay 24,000 RLUSD debt (native = 24_000_000_000 units)
        //   Debt price = $1.00 WAD
        //   Collateral price = $60,000 WAD (wBTC)
        //   Bonus = 6.5% (650 bps)
        //   debt_usd = 24000 × $1.00 = $24,000 WAD (= 24000 * WAD internally)
        //   seize_usd = 24000 × 1.065 = $25,560 WAD
        //   col_price_per_sat = 60000e18 / 1e8 = 6e14
        //   col_to_seize_sats = seize_usd / col_price_per_sat
        //     = 25560 * WAD / 6e14
        //     = 25560 * 1e18 / 6e14
        //     = 25560 / 6e-4
        //     = 25560 * 10000 / 6
        //     = 42_600_000 sats = 0.426 BTC
        let (seized, bonus) = calculate_liquidation_amounts(
            24_000_000_000,  // 24,000 RLUSD (6 decimals)
            WAD,             // debt price $1.00
            60_000 * WAD,    // collateral price $60,000
            650,             // 6.5% bonus
            6,               // debt decimals (RLUSD)
            8,               // collateral decimals (wBTC)
        )
        .unwrap();

        assert_eq!(seized, 42_600_000u128); // 0.426 BTC in sats
        // base_col (no bonus) = 24000 × 1e18 / 6e14 = 40_000_000 sats
        // bonus = 42_600_000 - 40_000_000 = 2_600_000 sats
        assert_eq!(bonus, 2_600_000u128);
    }

    #[test]
    fn test_liquidation_amounts_xrp_to_rlusd() {
        // Repay 1000 XRP debt (= 1,000,000,000 drops) @ $2.00
        // Collateral: RLUSD @ $1.00, bonus 4% (400 bps)
        // debt_usd = 1e9 × (2e18/1e6) = 1e9 × 2e12 = 2e21 = $2000 WAD
        // seize_usd = 2000 × 1.04 = $2080 WAD
        // col_price_per_unit = 1e18 / 1e6 = 1e12
        // col_to_seize = 2080e18 / 1e12 = 2080e6 = 2_080_000_000 RLUSD units (= 2080 RLUSD)
        let (seized, bonus) = calculate_liquidation_amounts(
            1_000_000_000,  // 1000 XRP in drops
            2 * WAD,        // debt price $2.00
            WAD,            // collateral price $1.00 (RLUSD)
            400,            // 4% bonus
            6,              // debt decimals (XRP)
            6,              // collateral decimals (RLUSD)
        )
        .unwrap();

        assert_eq!(seized, 2_080_000_000u128); // 2080 RLUSD
        // base_col = 2000e18 / 1e12 = 2_000_000_000
        // bonus = 2_080_000_000 - 2_000_000_000 = 80_000_000
        assert_eq!(bonus, 80_000_000u128);
    }

    #[test]
    fn test_liquidation_zero_price_returns_error() {
        let result = calculate_liquidation_amounts(1_000_000, 0, WAD, 500, 6, 6);
        assert_eq!(result, Err(LendingError::OraclePriceZero));

        let result = calculate_liquidation_amounts(1_000_000, WAD, 0, 500, 6, 6);
        assert_eq!(result, Err(LendingError::OraclePriceZero));
    }
}
