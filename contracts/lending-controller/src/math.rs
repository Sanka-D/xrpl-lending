/// Fixed-point math with WAD (18 decimals) and RAY (27 decimals) precision.
///
/// # Overflow constraints (u128)
///
/// u128::MAX ≈ 3.4 × 10^38. This constrains operand sizes:
///
/// | Function      | Computes        | Safe when                    |
/// |---------------|-----------------|------------------------------|
/// | wad_mul(a, b) | a × b / 1e18   | a × b < 3.4e38              |
/// | wad_div(a, b) | a × 1e18 / b   | a < 3.4e20                  |
/// | ray_mul(a, b) | a × b / 1e27   | a × b < 3.4e38              |
/// | ray_div(a, b) | a × 1e27 / b   | a < 3.4e11                  |
///
/// For this protocol, interest indices use WAD (not RAY) to avoid overflow
/// when multiplying debt_amount (up to ~1e20) by index (~1e18).

// -- Constants --

pub const WAD: u128 = 1_000_000_000_000_000_000; // 1e18
pub const HALF_WAD: u128 = 500_000_000_000_000_000; // 5e17
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000; // 1e27
pub const HALF_RAY: u128 = 500_000_000_000_000_000_000_000_000; // 5e26
pub const WAD_RAY_RATIO: u128 = 1_000_000_000; // 1e9

pub const SECONDS_PER_YEAR: u128 = 365 * 24 * 3600; // 31_536_000

/// Basis points: 10_000 = 100%
pub const BPS: u128 = 10_000;
pub const HALF_BPS: u128 = 5_000;

/// Maximum safe value for wad_div numerator: u128::MAX / WAD
pub const WAD_DIV_MAX_A: u128 = u128::MAX / WAD;

// -- WAD arithmetic --

/// (a × b + WAD/2) / WAD — rounded half-up
pub fn wad_mul(a: u128, b: u128) -> Option<u128> {
    if a == 0 || b == 0 {
        return Some(0);
    }
    let product = a.checked_mul(b)?;
    product.checked_add(HALF_WAD)?.checked_div(WAD)
}

/// (a × WAD + b/2) / b — rounded half-up
pub fn wad_div(a: u128, b: u128) -> Option<u128> {
    if b == 0 {
        return None;
    }
    let numerator = a.checked_mul(WAD)?;
    numerator.checked_add(b / 2)?.checked_div(b)
}

// -- RAY arithmetic --

/// (a × b + RAY/2) / RAY — rounded half-up
pub fn ray_mul(a: u128, b: u128) -> Option<u128> {
    if a == 0 || b == 0 {
        return Some(0);
    }
    let product = a.checked_mul(b)?;
    product.checked_add(HALF_RAY)?.checked_div(RAY)
}

/// (a × RAY + b/2) / b — rounded half-up
pub fn ray_div(a: u128, b: u128) -> Option<u128> {
    if b == 0 {
        return None;
    }
    let numerator = a.checked_mul(RAY)?;
    numerator.checked_add(b / 2)?.checked_div(b)
}

// -- Conversions --

/// WAD → RAY (multiply by 1e9)
pub fn wad_to_ray(a: u128) -> Option<u128> {
    a.checked_mul(WAD_RAY_RATIO)
}

/// RAY → WAD (divide by 1e9, rounded)
pub fn ray_to_wad(a: u128) -> u128 {
    (a + WAD_RAY_RATIO / 2) / WAD_RAY_RATIO
}

// -- Basis-point arithmetic --

/// (value × bps + 5000) / 10000
pub fn bps_mul(value: u128, basis_points: u128) -> Option<u128> {
    if value == 0 || basis_points == 0 {
        return Some(0);
    }
    let product = value.checked_mul(basis_points)?;
    product.checked_add(HALF_BPS)?.checked_div(BPS)
}

/// (value × 10000 + bps/2) / bps
pub fn bps_div(value: u128, basis_points: u128) -> Option<u128> {
    if basis_points == 0 {
        return None;
    }
    let numerator = value.checked_mul(BPS)?;
    numerator.checked_add(basis_points / 2)?.checked_div(basis_points)
}

// -- Interest helpers --

/// Linear interest factor: 1 + rate_per_second × duration.
/// Returns WAD-scaled factor (1 WAD = 1.0×).
/// rate_per_second is WAD-scaled (e.g. 4% APY → 4e16 / 31_536_000 ≈ 1_268_391_679).
pub fn calculate_linear_interest(rate_per_second: u128, duration: u128) -> Option<u128> {
    let interest = rate_per_second.checked_mul(duration)?;
    WAD.checked_add(interest)
}

/// Compound interest factor using 2-term Taylor: 1 + rt + (rt)²/2.
/// Returns WAD-scaled factor. More accurate than linear for multi-hour accruals.
/// rate_per_second is WAD-scaled.
pub fn calculate_compound_interest(rate_per_second: u128, duration: u128) -> Option<u128> {
    if duration == 0 {
        return Some(WAD);
    }

    let rt = rate_per_second.checked_mul(duration)?;

    if duration == 1 {
        return WAD.checked_add(rt);
    }

    // (rt)^2 / (2 × WAD) — second term of Taylor expansion
    let rt_squared = wad_mul(rt, rt)?;
    let second_term = rt_squared / 2;

    WAD.checked_add(rt)?.checked_add(second_term)
}

/// Convert an annual percentage rate in BPS to a per-second rate in WAD.
/// e.g. 400 bps (4%) → 4e16 / 31_536_000 ≈ 1_268_391_679 WAD/s
pub fn annual_bps_to_per_second_wad(annual_bps: u128) -> u128 {
    // (annual_bps × WAD) / (BPS × SECONDS_PER_YEAR)
    // = annual_bps × 1e18 / (10_000 × 31_536_000)
    // = annual_bps × 1e18 / 315_360_000_000
    (annual_bps * WAD) / (BPS * SECONDS_PER_YEAR)
}

// -- Utility --

/// Minimum of two values
pub fn min(a: u128, b: u128) -> u128 {
    if a < b { a } else { b }
}

/// Maximum of two values
pub fn max(a: u128, b: u128) -> u128 {
    if a > b { a } else { b }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================
    // WAD arithmetic
    // ========================

    #[test]
    fn wad_mul_identity() {
        // a × 1.0 = a
        assert_eq!(wad_mul(42 * WAD, WAD), Some(42 * WAD));
    }

    #[test]
    fn wad_mul_basic() {
        assert_eq!(wad_mul(2 * WAD, 3 * WAD), Some(6 * WAD));
        assert_eq!(wad_mul(WAD / 2, WAD / 2), Some(WAD / 4));
    }

    #[test]
    fn wad_mul_zero() {
        assert_eq!(wad_mul(0, WAD), Some(0));
        assert_eq!(wad_mul(WAD, 0), Some(0));
        assert_eq!(wad_mul(0, 0), Some(0));
    }

    #[test]
    fn wad_mul_rounding() {
        // WAD/3 × WAD/3 = WAD/9, check rounding half-up
        let third = WAD / 3; // 333_333_333_333_333_333
        let result = wad_mul(third, third).unwrap();
        let expected = WAD / 9; // 111_111_111_111_111_111
        // Allow ±1 for rounding
        assert!((result as i128 - expected as i128).unsigned_abs() <= 1);
    }

    #[test]
    fn wad_mul_overflow_returns_none() {
        // u128::MAX × 2 → overflow
        assert_eq!(wad_mul(u128::MAX, 2), None);
        // Large but sub-max values
        assert_eq!(wad_mul(u128::MAX / WAD + 1, WAD + 1), None);
    }

    #[test]
    fn wad_mul_large_realistic_values() {
        // Protocol arithmetic uses native units (not WAD-scaled amounts):
        //   usd = wad_mul(amount_native, price_wad)  → result in native × WAD / WAD = native
        // e.g. 1e11 drops × 5e17 (price WAD) = 5e28 < 3.4e38 ✓
        let xrp_drops = 100_000_000_000u128; // 1e11 = 100B XRP max supply
        let price_wad = WAD / 2;             // $0.50 → 5e17
        // 1e11 × 5e17 = 5e28 fits u128
        let usd = wad_mul(xrp_drops, price_wad);
        assert!(usd.is_some());
        assert_eq!(usd.unwrap(), 50_000_000_000); // 5e10 native-unit equivalent

        // wad_mul of two WAD-scaled values overflows for protocol-scale amounts:
        // 100_000 WAD × 0.5 WAD = 1e23 × 5e17 = 5e40 > u128::MAX → None
        assert_eq!(wad_mul(100_000 * WAD, WAD / 2), None);
    }

    #[test]
    fn wad_div_identity() {
        assert_eq!(wad_div(42 * WAD, WAD), Some(42 * WAD));
    }

    #[test]
    fn wad_div_basic() {
        assert_eq!(wad_div(6 * WAD, 3 * WAD), Some(2 * WAD));
        assert_eq!(wad_div(WAD, 2 * WAD), Some(WAD / 2));
    }

    #[test]
    fn wad_div_by_zero() {
        assert_eq!(wad_div(WAD, 0), None);
        assert_eq!(wad_div(0, 0), None);
    }

    #[test]
    fn wad_div_zero_numerator() {
        assert_eq!(wad_div(0, WAD), Some(0));
    }

    #[test]
    fn wad_div_overflow_returns_none() {
        // a × WAD must fit u128 → a must be < ~3.4e20
        let too_large = WAD_DIV_MAX_A + 1;
        assert_eq!(wad_div(too_large, WAD), None);
    }

    #[test]
    fn wad_div_max_safe_value() {
        // wad_div(a, b) = (a * WAD + b/2) / b
        // The +b/2 rounding step means the true safe limit is slightly below WAD_DIV_MAX_A.
        // WAD_DIV_MAX_A = u128::MAX / WAD → a * WAD fits, but a * WAD + b/2 can overflow.
        // Safe value: use a value well below the boundary.
        let safe = WAD_DIV_MAX_A / 2;
        assert!(wad_div(safe, WAD).is_some());
        // At WAD_DIV_MAX_A the +b/2 addition overflows, so None is expected.
        assert_eq!(wad_div(WAD_DIV_MAX_A, WAD), None);
    }

    #[test]
    fn wad_mul_div_roundtrip() {
        // wad_mul(a, b) requires a * b < u128::MAX ≈ 3.4e38.
        // Keep both operands well within range: a, b < 1e9 WAD.
        let a = 123_456 * WAD;         // ≈ 1.23e23
        let b = 789 * WAD / 1000;      // ≈ 7.89e17 (0.789 WAD)
        // a * b = 1.23e23 * 7.89e17 = 9.7e40 → still overflows!
        // Must keep a * b < 3.4e38, so both must be < ~1e10 WAD each when the other is WAD.
        // Use small dimensionless factors:
        let a2 = 1_234 * WAD;          // ≈ 1.23e21
        let b2 = 5678 * WAD / 10_000;  // ≈ 5.68e17 (0.5678 WAD)
        // a2 * b2 = 1.23e21 * 5.68e17 = 7e38 → borderline, use smaller:
        let a3 = 100 * WAD;            // 1e20
        let b3 = 75 * WAD / 100;       // 7.5e17
        // a3 * b3 = 1e20 * 7.5e17 = 7.5e37 < 3.4e38 ✓
        let product = wad_mul(a3, b3).unwrap();
        let back = wad_div(product, b3).unwrap();
        let diff = if back > a3 { back - a3 } else { a3 - back };
        assert!(diff <= 1, "roundtrip diff {} > 1", diff);
    }

    // ========================
    // RAY arithmetic
    // ========================

    #[test]
    fn ray_mul_small_values() {
        // ray_mul is for small_amount × ray_factor
        assert_eq!(ray_mul(1000, RAY), Some(1000));
        assert_eq!(ray_mul(1000, 2 * RAY), Some(2000));
        assert_eq!(ray_mul(1, RAY), Some(1));
    }

    #[test]
    fn ray_mul_zero() {
        assert_eq!(ray_mul(0, RAY), Some(0));
        assert_eq!(ray_mul(1000, 0), Some(0));
    }

    #[test]
    fn ray_mul_overflow() {
        // RAY × RAY = 1e54 → overflows u128
        assert_eq!(ray_mul(RAY, RAY), None);
        // WAD × RAY = 1e45 → overflows u128
        assert_eq!(ray_mul(WAD, RAY), None);
    }

    #[test]
    fn ray_div_small_values() {
        assert_eq!(ray_div(1000, RAY), Some(1000));
        assert_eq!(ray_div(2000, 2 * RAY), Some(1000));
    }

    #[test]
    fn ray_div_by_zero() {
        assert_eq!(ray_div(1000, 0), None);
    }

    #[test]
    fn ray_div_overflow() {
        // a × RAY must fit → a < ~3.4e11
        assert_eq!(ray_div(RAY, RAY), None); // RAY × RAY overflows
    }

    // ========================
    // Conversions
    // ========================

    #[test]
    fn wad_ray_roundtrip() {
        assert_eq!(wad_to_ray(WAD), Some(RAY));
        assert_eq!(ray_to_wad(RAY), WAD);

        let val = 12345 * WAD;
        let as_ray = wad_to_ray(val).unwrap();
        assert_eq!(ray_to_wad(as_ray), val);
    }

    #[test]
    fn wad_to_ray_overflow() {
        // Very large WAD value × 1e9 could overflow
        let too_large = u128::MAX / WAD_RAY_RATIO + 1;
        assert_eq!(wad_to_ray(too_large), None);
    }

    #[test]
    fn ray_to_wad_rounding() {
        // RAY + 1 → should round to WAD
        assert_eq!(ray_to_wad(RAY + 1), WAD);
        // HALF of WAD_RAY_RATIO rounds up
        assert_eq!(ray_to_wad(WAD_RAY_RATIO / 2), 1); // rounds 0.5 → 1
        assert_eq!(ray_to_wad(WAD_RAY_RATIO / 2 - 1), 0); // rounds 0.499.. → 0
    }

    // ========================
    // Basis-point arithmetic
    // ========================

    #[test]
    fn bps_mul_basic() {
        // 100 WAD × 75% (7500 bps) = 75 WAD
        assert_eq!(bps_mul(100 * WAD, 7500), Some(75 * WAD));
        // 100 WAD × 100% (10000 bps) = 100 WAD
        assert_eq!(bps_mul(100 * WAD, BPS), Some(100 * WAD));
        // 100 WAD × 50% (5000 bps) = 50 WAD
        assert_eq!(bps_mul(100 * WAD, 5000), Some(50 * WAD));
    }

    #[test]
    fn bps_mul_zero() {
        assert_eq!(bps_mul(0, 7500), Some(0));
        assert_eq!(bps_mul(100 * WAD, 0), Some(0));
    }

    #[test]
    fn bps_mul_small_percentages() {
        // 1 bps = 0.01%
        // 10000 WAD × 1 bps = 1 WAD
        assert_eq!(bps_mul(10000 * WAD, 1), Some(WAD));
    }

    #[test]
    fn bps_div_basic() {
        // 75 WAD / 75% = 100 WAD
        assert_eq!(bps_div(75 * WAD, 7500), Some(100 * WAD));
    }

    #[test]
    fn bps_div_by_zero() {
        assert_eq!(bps_div(100 * WAD, 0), None);
    }

    #[test]
    fn bps_mul_risk_params() {
        // XRP collateral: 1000 WAD × LTV 75% = 750 WAD
        assert_eq!(bps_mul(1000 * WAD, 7500), Some(750 * WAD));
        // RLUSD collateral: 1000 WAD × LTV 80% = 800 WAD
        assert_eq!(bps_mul(1000 * WAD, 8000), Some(800 * WAD));
        // wBTC collateral: 1000 WAD × LTV 73% = 730 WAD
        assert_eq!(bps_mul(1000 * WAD, 7300), Some(730 * WAD));
    }

    #[test]
    fn bps_mul_liquidation_bonus() {
        // Liquidation bonus: debt_value × (1 + bonus%)
        // XRP bonus 5% = 500 bps → factor = 10500 bps
        let debt_value = 100 * WAD;
        let with_bonus = bps_mul(debt_value, 10500).unwrap(); // 10000 + 500
        assert_eq!(with_bonus, 105 * WAD);
    }

    // ========================
    // Interest helpers
    // ========================

    #[test]
    fn linear_interest_zero_rate() {
        assert_eq!(calculate_linear_interest(0, 3600), Some(WAD));
    }

    #[test]
    fn linear_interest_zero_duration() {
        assert_eq!(calculate_linear_interest(1_000_000, 0), Some(WAD));
    }

    #[test]
    fn linear_interest_one_year_4pct() {
        // 4% APY → per-second rate = 4e16 / 31_536_000 ≈ 1_268_391_679
        let rate_per_sec = annual_bps_to_per_second_wad(400);
        let factor = calculate_linear_interest(rate_per_sec, SECONDS_PER_YEAR).unwrap();
        // factor should be ≈ 1.04 WAD
        let expected = WAD + WAD * 4 / 100; // 1.04e18
        let diff = if factor > expected { factor - expected } else { expected - factor };
        // Allow small rounding from integer division in annual_bps_to_per_second_wad
        assert!(diff < WAD / 1000, "4% linear off by {}", diff); // < 0.1% error
    }

    #[test]
    fn compound_interest_zero() {
        assert_eq!(calculate_compound_interest(1_000_000, 0), Some(WAD));
    }

    #[test]
    fn compound_interest_one_second() {
        let rate = 1_000_000_000u128; // ~1e9 WAD/s
        let factor = calculate_compound_interest(rate, 1).unwrap();
        assert_eq!(factor, WAD + rate);
    }

    #[test]
    fn compound_gt_linear_for_long_durations() {
        let rate = annual_bps_to_per_second_wad(400); // 4% APY
        let one_year = SECONDS_PER_YEAR;
        let linear = calculate_linear_interest(rate, one_year).unwrap();
        let compound = calculate_compound_interest(rate, one_year).unwrap();
        // Compound must be strictly greater than linear for rate > 0, duration > 1
        assert!(compound > linear, "compound {} should > linear {}", compound, linear);
    }

    #[test]
    fn compound_interest_one_year_4pct() {
        let rate = annual_bps_to_per_second_wad(400);
        let factor = calculate_compound_interest(rate, SECONDS_PER_YEAR).unwrap();
        // True compound: e^0.04 ≈ 1.04081. Our 2-term Taylor: 1 + 0.04 + 0.0008 = 1.0408
        // Should be close to 1.0408 WAD
        let low = WAD * 1040 / 1000; // 1.040
        let high = WAD * 1041 / 1000; // 1.041
        assert!(factor >= low && factor <= high,
            "4% compound factor {} not in [1.040, 1.041]", factor);
    }

    #[test]
    fn compound_interest_high_rate_one_year() {
        // 300% (slope2 max) → per-second rate
        let rate = annual_bps_to_per_second_wad(30000);
        let factor = calculate_compound_interest(rate, SECONDS_PER_YEAR).unwrap();
        // 1 + 3.0 + 4.5 = 8.5 (2-term Taylor of e^3 ≈ 20.08)
        // Taylor underestimates heavily at high rates, but that's a known limit.
        // Factor should be around 8.5 WAD
        let expected = WAD * 85 / 10;
        let diff = if factor > expected { factor - expected } else { expected - factor };
        assert!(diff < WAD / 10, "300% compound factor {} far from 8.5 WAD", factor);
    }

    // ========================
    // annual_bps_to_per_second_wad
    // ========================

    #[test]
    fn bps_to_rate_conversion() {
        // 4% = 400 bps
        let rate = annual_bps_to_per_second_wad(400);
        // rate × SECONDS_PER_YEAR should ≈ 0.04 WAD
        let annual = rate * SECONDS_PER_YEAR;
        let expected = WAD * 4 / 100;
        let diff = if annual > expected { annual - expected } else { expected - annual };
        // Truncation error from integer division
        assert!(diff < WAD / 10_000, "rate reconversion off by {}", diff);
    }

    #[test]
    fn bps_to_rate_zero() {
        assert_eq!(annual_bps_to_per_second_wad(0), 0);
    }

    #[test]
    fn bps_to_rate_300pct() {
        let rate = annual_bps_to_per_second_wad(30000);
        let annual = rate * SECONDS_PER_YEAR;
        let expected = WAD * 3; // 3.0 in WAD
        let diff = if annual > expected { annual - expected } else { expected - annual };
        assert!(diff < WAD / 10_000, "300% rate off by {}", diff);
    }

    // ========================
    // min / max
    // ========================

    #[test]
    fn test_min_max() {
        assert_eq!(min(1, 2), 1);
        assert_eq!(min(2, 1), 1);
        assert_eq!(min(5, 5), 5);
        assert_eq!(max(1, 2), 2);
        assert_eq!(max(2, 1), 2);
        assert_eq!(max(5, 5), 5);
    }

    // ========================
    // Edge cases
    // ========================

    #[test]
    fn wad_mul_one_wei() {
        // Smallest possible value × 1.0
        assert_eq!(wad_mul(1, WAD), Some(1));
        // 1 × 1 / WAD → rounds to 0
        assert_eq!(wad_mul(1, 1), Some(0));
    }

    #[test]
    fn wad_mul_max_safe() {
        // u128::MAX ≈ 3.4e38. wad_mul requires a × b < u128::MAX.
        // Large WAD-scaled values overflow quickly:
        //   1e6 WAD × 1e6 WAD = 1e24 × 1e24 = 1e48 → overflow
        assert_eq!(wad_mul(1_000_000 * WAD, 1_000_000 * WAD), None);
        //   Large single value also overflows:
        assert_eq!(wad_mul(18_446_744_073 * WAD, 18_446_744_073 * WAD), None);
        // Safe: small values × WAD-scaled factor (native × price pattern)
        assert!(wad_mul(1_000_000u128, WAD).is_some()); // 1e6 × 1e18 = 1e24 ✓
        assert!(wad_mul(1_000_000_000_000u128, WAD).is_some()); // 1e12 × 1e18 = 1e30 ✓
        assert!(wad_mul(100_000_000_000_000_000u128, WAD).is_some()); // 1e17 × 1e18 = 1e35 ✓
    }

    #[test]
    fn wad_mul_protocol_realistic() {
        // Max realistic: 100B XRP = 1e11, in WAD = 1e11 × 1e18 = 1e29
        // × price 100 USD in WAD = 1e20
        // Product: 1e29 × 1e20 = 1e49 → OVERFLOW
        // → Must keep amounts smaller, e.g. amounts in native units, prices in WAD
        //
        // Alternative: amount_native × price_wad / WAD
        // 1e11 (native) × 1e20 (price WAD) = 1e31 < 3.4e38 ✓
        let xrp_drops = 100_000_000_000u128; // 100B drops = 100B XRP
        let price_wad = 50 * WAD / 100; // $0.50 in WAD
        // This is actually: drops × price_wad, then divide by WAD for USD value
        let usd_value = wad_mul(xrp_drops, price_wad);
        assert!(usd_value.is_some());
        // 1e11 × 5e17 = 5e28, + HALF_WAD, / WAD = 5e10
        assert_eq!(usd_value.unwrap(), 50_000_000_000); // $50B
    }
}
