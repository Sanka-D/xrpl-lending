/// DIA oracle price reader for the XRPL lending protocol.
///
/// # Architecture
///
/// `LedgerReader` is a trait that abstracts XRPL host function calls:
///   - In production (WASM on XRPL): backed by `cache_ledger_obj` + `get_ledger_obj_nested_field`
///     from the xrpl-wasm-std host ABI (to be wired in a later phase)
///   - In tests: backed by a fixed-size mock struct (`MockOracle`)
///
/// # DIA Price Format (XLS-47 Oracle)
///
/// Each PriceDataSeries entry has:
///   AssetPrice: u64   — raw integer mantissa
///   Scale: i8         — decimal exponent (actual_price = AssetPrice × 10^Scale)
///
/// WAD conversion:
///   price_wad = AssetPrice × 10^(18 + Scale)
///
/// Examples:
///   XRP  $2.00    → AssetPrice=200_000_000, Scale=-8  → 200M × 10^10 = 2.0 WAD ✓
///   BTC  $67432   → AssetPrice=6_743_200_000_000, Scale=-8 → ... × 10^10 = 67432.0 WAD ✓
///   RLUSD$1.00    → AssetPrice=100_000_000, Scale=-8  → 100M × 10^10 = 1.0 WAD ✓
///
/// # RLUSD Circuit Breaker
///
/// RLUSD is a regulated stablecoin; we treat its price as $1.00 exactly but use the
/// DIA feed purely as a circuit breaker:
///   - If DIA price ∈ [0.95, 1.05] → return 1.0 WAD (hardcoded peg)
///   - If DIA price ∉ [0.95, 1.05] → return OracleCircuitBreaker (market pause)

use crate::errors::{LendingError, LendingResult};
use crate::math::{BPS, WAD};
use crate::state::{
    OracleConfig, ASSET_RLUSD, DIA_DOCUMENT_ID, DIA_ORACLE_ACCOUNT, RLUSD_CB_HIGH_BPS,
    RLUSD_CB_LOW_BPS, RLUSD_FIXED_PRICE, TICKER_BTC_HEX, TICKER_RLUSD_HEX, TICKER_XRP_HEX,
    V1_ORACLES,
};

// ── Precomputed powers of 10 ──────────────────────────────────────────────────
// 10^0 through 10^37 inclusive. Used by raw_to_wad.
// u128::MAX ≈ 3.4 × 10^38, so all entries fit.

#[rustfmt::skip]
pub(crate) const POW10: [u128; 38] = [
    1,                                              // 10^0
    10,                                             // 10^1
    100,                                            // 10^2
    1_000,                                          // 10^3
    10_000,                                         // 10^4
    100_000,                                        // 10^5
    1_000_000,                                      // 10^6
    10_000_000,                                     // 10^7
    100_000_000,                                    // 10^8
    1_000_000_000,                                  // 10^9
    10_000_000_000,                                 // 10^10
    100_000_000_000,                                // 10^11
    1_000_000_000_000,                              // 10^12
    10_000_000_000_000,                             // 10^13
    100_000_000_000_000,                            // 10^14
    1_000_000_000_000_000,                          // 10^15
    10_000_000_000_000_000,                         // 10^16
    100_000_000_000_000_000,                        // 10^17
    1_000_000_000_000_000_000,                      // 10^18 = WAD
    10_000_000_000_000_000_000,                     // 10^19
    100_000_000_000_000_000_000,                    // 10^20
    1_000_000_000_000_000_000_000,                  // 10^21
    10_000_000_000_000_000_000_000,                 // 10^22
    100_000_000_000_000_000_000_000,                // 10^23
    1_000_000_000_000_000_000_000_000,              // 10^24
    10_000_000_000_000_000_000_000_000,             // 10^25
    100_000_000_000_000_000_000_000_000,            // 10^26
    1_000_000_000_000_000_000_000_000_000,          // 10^27
    10_000_000_000_000_000_000_000_000_000,         // 10^28
    100_000_000_000_000_000_000_000_000_000,        // 10^29
    1_000_000_000_000_000_000_000_000_000_000,      // 10^30
    10_000_000_000_000_000_000_000_000_000_000,     // 10^31
    100_000_000_000_000_000_000_000_000_000_000,    // 10^32
    1_000_000_000_000_000_000_000_000_000_000_000,  // 10^33
    10_000_000_000_000_000_000_000_000_000_000_000, // 10^34
    100_000_000_000_000_000_000_000_000_000_000_000, // 10^35
    1_000_000_000_000_000_000_000_000_000_000_000_000, // 10^36
    10_000_000_000_000_000_000_000_000_000_000_000_000, // 10^37
];

// ── RawOracleData ─────────────────────────────────────────────────────────────

/// Raw price data extracted from a DIA oracle PriceDataSeries entry.
/// Mirrors the on-chain XLS-47 Oracle ledger object fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawOracleData {
    /// Raw price mantissa. Actual price = asset_price × 10^scale.
    pub asset_price: u64,
    /// Decimal scale factor (typically negative, e.g. -8 for 8 decimal places).
    pub scale: i8,
    /// UNIX timestamp (seconds) when this price was last updated by DIA.
    pub last_update_time: u64,
}

// ── LedgerReader trait ────────────────────────────────────────────────────────

/// Abstraction over XRPL host ledger reads.
///
/// Implement this with real XRPL host calls in production;
/// use `MockOracle` in unit tests.
pub trait LedgerReader {
    /// Attempt to read the oracle price entry for a specific asset ticker
    /// from the given oracle account's document.
    ///
    /// Returns `None` if the oracle account, document, or ticker are not found.
    fn read_oracle_price(
        &self,
        oracle_account: &[u8; 20],
        document_id: u32,
        asset_ticker: &[u8; 20],
    ) -> Option<RawOracleData>;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Convert a raw DIA oracle entry to a WAD-scaled USD price.
///
/// Computes: price_wad = asset_price × 10^(18 + scale)
///
/// # Overflow
/// For typical DIA scale values (-8 to -2), the exponent 18+scale is 10..16,
/// and asset_price × 10^16 is at most 1.8e19 × 1e16 = 1.8e35 < u128::MAX ✓
fn raw_to_wad(raw: &RawOracleData) -> LendingResult<u128> {
    if raw.asset_price == 0 {
        return Err(LendingError::OraclePriceZero);
    }

    // Signed exponent: 18 + scale. Typical range: 10 (scale=-8) to 18 (scale=0).
    let exp: i16 = 18_i16 + (raw.scale as i16);

    let price_wad: u128 = if exp >= 0 {
        let exp_u = exp as usize;
        if exp_u >= POW10.len() {
            // Exponent ≥ 38 → guaranteed overflow for any nonzero asset_price
            return Err(LendingError::MathOverflow);
        }
        (raw.asset_price as u128)
            .checked_mul(POW10[exp_u])
            .ok_or(LendingError::MathOverflow)?
    } else {
        // Negative exponent (scale < -18): divide to get sub-WAD precision.
        // Rare in practice but handle gracefully.
        let neg_exp = (-exp) as usize;
        if neg_exp >= POW10.len() {
            // Divisor ≥ 10^38 would make any u64 asset_price → 0
            return Err(LendingError::OraclePriceZero);
        }
        (raw.asset_price as u128) / POW10[neg_exp]
    };

    if price_wad == 0 {
        return Err(LendingError::OraclePriceZero);
    }

    Ok(price_wad)
}

/// Returns `OracleStale` if the price age exceeds `max_staleness` seconds.
fn check_staleness(
    last_update_time: u64,
    max_staleness: u64,
    current_time: u64,
) -> LendingResult<()> {
    let age = current_time.saturating_sub(last_update_time);
    if age > max_staleness {
        return Err(LendingError::OracleStale);
    }
    Ok(())
}

/// Read and validate the RLUSD price with circuit-breaker logic.
///
/// Returns 1.0 WAD (RLUSD_FIXED_PRICE) if DIA price is within [0.95, 1.05] USD.
/// Returns OracleCircuitBreaker if price is outside bounds.
fn get_rlusd_price<L: LedgerReader>(
    reader: &L,
    oracle_config: &OracleConfig,
    current_time: u64,
) -> LendingResult<u128> {
    let raw = reader
        .read_oracle_price(
            &oracle_config.dia_account,
            oracle_config.oracle_document_id,
            &oracle_config.asset_ticker_hex,
        )
        .ok_or(LendingError::OracleAssetNotFound)?;

    check_staleness(raw.last_update_time, oracle_config.max_staleness, current_time)?;

    let price_wad = raw_to_wad(&raw)?;

    // Circuit breaker bounds (WAD-scaled):
    //   low  = 9500 × WAD / 10000 = 0.95 WAD = 950_000_000_000_000_000
    //   high = 10500 × WAD / 10000 = 1.05 WAD = 1_050_000_000_000_000_000
    //
    // Overflow: 10500 × WAD = 10500 × 1e18 = 1.05e22 < u128::MAX ✓
    let low_bound: u128 = (RLUSD_CB_LOW_BPS as u128) * WAD / BPS;
    let high_bound: u128 = (RLUSD_CB_HIGH_BPS as u128) * WAD / BPS;

    if price_wad < low_bound || price_wad > high_bound {
        return Err(LendingError::OracleCircuitBreaker);
    }

    // Price is valid and within peg bounds — return the hardcoded 1.0 USD.
    Ok(RLUSD_FIXED_PRICE)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Get the WAD-scaled USD price for the given asset.
///
/// Dispatches to the RLUSD circuit-breaker path for `asset_index == ASSET_RLUSD`.
/// For all other assets, reads DIA directly and checks staleness.
///
/// # Returns
/// WAD-scaled price (e.g. $2.15 XRP → 2_150_000_000_000_000_000)
pub fn get_asset_price<L: LedgerReader>(
    reader: &L,
    asset_index: u8,
    oracle_config: &OracleConfig,
    current_time: u64,
) -> LendingResult<u128> {
    if asset_index == ASSET_RLUSD {
        return get_rlusd_price(reader, oracle_config, current_time);
    }

    let raw = reader
        .read_oracle_price(
            &oracle_config.dia_account,
            oracle_config.oracle_document_id,
            &oracle_config.asset_ticker_hex,
        )
        .ok_or(LendingError::OracleAssetNotFound)?;

    check_staleness(raw.last_update_time, oracle_config.max_staleness, current_time)?;
    raw_to_wad(&raw)
}

/// Fetch all three V1 asset prices in index order: [XRP, RLUSD, wBTC].
///
/// Fails fast on the first error. Used by `health.rs` to price collateral and debt.
pub fn get_all_prices<L: LedgerReader>(
    reader: &L,
    current_time: u64,
) -> LendingResult<[u128; 3]> {
    let mut prices = [0u128; 3];
    for i in 0..V1_ORACLES.len() {
        prices[i] = get_asset_price(reader, i as u8, &V1_ORACLES[i], current_time)?;
    }
    Ok(prices)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MAX_ORACLE_STALENESS_SECS, XRP_ORACLE, RLUSD_ORACLE, WBTC_ORACLE};

    // ── MockOracle ────────────────────────────────────────────────────────────

    /// Test double for `LedgerReader`.
    ///
    /// Holds optional prices for XRP (0), RLUSD (1), wBTC (2) by ticker match.
    struct MockOracle {
        xrp: Option<RawOracleData>,
        rlusd: Option<RawOracleData>,
        wbtc: Option<RawOracleData>,
    }

    impl MockOracle {
        fn with_prices(xrp: RawOracleData, rlusd: RawOracleData, wbtc: RawOracleData) -> Self {
            MockOracle {
                xrp: Some(xrp),
                rlusd: Some(rlusd),
                wbtc: Some(wbtc),
            }
        }

        fn empty() -> Self {
            MockOracle { xrp: None, rlusd: None, wbtc: None }
        }
    }

    impl LedgerReader for MockOracle {
        fn read_oracle_price(
            &self,
            _oracle_account: &[u8; 20],
            _document_id: u32,
            asset_ticker: &[u8; 20],
        ) -> Option<RawOracleData> {
            if asset_ticker == &TICKER_XRP_HEX {
                self.xrp
            } else if asset_ticker == &TICKER_RLUSD_HEX {
                self.rlusd
            } else if asset_ticker == &TICKER_BTC_HEX {
                self.wbtc
            } else {
                None
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Create a fresh (non-stale) RawOracleData at `current_time = 0`.
    fn fresh(asset_price: u64, scale: i8) -> RawOracleData {
        RawOracleData { asset_price, scale, last_update_time: 0 }
    }

    /// Create a stale RawOracleData (last_update way in the past).
    fn stale(asset_price: u64, scale: i8) -> RawOracleData {
        RawOracleData {
            asset_price,
            scale,
            last_update_time: 0,
        }
        // Will be stale when current_time > MAX_ORACLE_STALENESS_SECS
    }

    // Standard test prices (scale=-8, typical DIA format)
    // XRP $2.00: 200_000_000 × 10^(-8) = 2.0, WAD = 200_000_000 × 10^10
    const XRP_PRICE: RawOracleData = RawOracleData { asset_price: 200_000_000, scale: -8, last_update_time: 0 };
    // RLUSD $1.00: 100_000_000 × 10^(-8) = 1.0
    const RLUSD_PRICE: RawOracleData = RawOracleData { asset_price: 100_000_000, scale: -8, last_update_time: 0 };
    // BTC $67,432.00: 6_743_200_000_000 × 10^(-8) = 67432.0
    const BTC_PRICE: RawOracleData = RawOracleData { asset_price: 6_743_200_000_000, scale: -8, last_update_time: 0 };

    const CURRENT_TIME: u64 = 0; // all test prices have last_update_time=0, current_time=0 → fresh

    // ── raw_to_wad ────────────────────────────────────────────────────────────

    #[test]
    fn raw_to_wad_zero_price_returns_error() {
        let raw = RawOracleData { asset_price: 0, scale: -8, last_update_time: 0 };
        assert_eq!(raw_to_wad(&raw), Err(LendingError::OraclePriceZero));
    }

    #[test]
    fn raw_to_wad_xrp_scale_neg8() {
        // XRP $2.00: 200_000_000 × 10^(-8) → 200_000_000 × 10^10 = 2e18 = 2 WAD
        let result = raw_to_wad(&XRP_PRICE).unwrap();
        assert_eq!(result, 2 * WAD, "XRP $2.00 should be 2 WAD");
    }

    #[test]
    fn raw_to_wad_btc_scale_neg8() {
        // BTC $67,432: 6_743_200_000_000 × 10^(-8) → × 10^10 = 67432 WAD
        let result = raw_to_wad(&BTC_PRICE).unwrap();
        let expected = 67_432 * WAD;
        assert_eq!(result, expected, "BTC should be 67432 WAD");
    }

    #[test]
    fn raw_to_wad_rlusd_scale_neg8() {
        // RLUSD $1.00: 100_000_000 × 10^(-8) → × 10^10 = 1e18 = 1 WAD
        let result = raw_to_wad(&RLUSD_PRICE).unwrap();
        assert_eq!(result, WAD, "RLUSD $1.00 should be 1 WAD");
    }

    #[test]
    fn raw_to_wad_scale_zero() {
        // scale=0: asset_price × 10^18 = asset_price WAD
        let raw = RawOracleData { asset_price: 2, scale: 0, last_update_time: 0 };
        let result = raw_to_wad(&raw).unwrap();
        assert_eq!(result, 2 * WAD);
    }

    #[test]
    fn raw_to_wad_scale_neg2() {
        // scale=-2: price $2.15 → AssetPrice=215, Scale=-2 → 215 × 10^16
        let raw = RawOracleData { asset_price: 215, scale: -2, last_update_time: 0 };
        let result = raw_to_wad(&raw).unwrap();
        // 215 × 10^16 = 2_150_000_000_000_000_000 = 2.15 WAD
        assert_eq!(result, WAD * 215 / 100);
    }

    #[test]
    fn raw_to_wad_scale_positive_small() {
        // scale=+2: price = asset × 100. Use small value to stay within bounds.
        // asset=1, scale=2 → price = 100.0 → 100 × 10^18 WAD
        let raw = RawOracleData { asset_price: 1, scale: 2, last_update_time: 0 };
        let result = raw_to_wad(&raw).unwrap();
        assert_eq!(result, 100 * WAD);
    }

    #[test]
    fn raw_to_wad_exponent_overflow_returns_error() {
        // scale=20 → exp = 18+20 = 38 → beyond POW10 table → MathOverflow
        let raw = RawOracleData { asset_price: 1, scale: 20, last_update_time: 0 };
        assert_eq!(raw_to_wad(&raw), Err(LendingError::MathOverflow));
    }

    #[test]
    fn raw_to_wad_multiplication_overflow_returns_error() {
        // u64::MAX × 10^18 = 1.8e19 × 1e18 = 1.8e37 < u128::MAX ✓ (scale=0 is fine)
        // But with scale=1: u64::MAX × 10^19 = 1.8e38 < 3.4e38 ✓ (also fine)
        // Need scale=2: u64::MAX × 10^20 = 1.8e39 > u128::MAX → overflow
        let raw = RawOracleData { asset_price: u64::MAX, scale: 2, last_update_time: 0 };
        // u64::MAX = 18_446_744_073_709_551_615 ≈ 1.8e19
        // 1.8e19 × 10^20 = 1.8e39 > 3.4e38 → overflow
        assert_eq!(raw_to_wad(&raw), Err(LendingError::MathOverflow));
    }

    #[test]
    fn raw_to_wad_very_negative_scale_gives_zero_error() {
        // scale=-100 → exp = 18-100 = -82 → neg_exp=82 >= POW10.len() → OraclePriceZero
        let raw = RawOracleData { asset_price: 1, scale: -100, last_update_time: 0 };
        assert_eq!(raw_to_wad(&raw), Err(LendingError::OraclePriceZero));
    }

    #[test]
    fn raw_to_wad_negative_scale_rounding() {
        // scale=-19 → exp = -1 → divide by 10^1
        // asset_price = 1 → 1/10 = 0 → OraclePriceZero
        let raw = RawOracleData { asset_price: 1, scale: -19, last_update_time: 0 };
        assert_eq!(raw_to_wad(&raw), Err(LendingError::OraclePriceZero));
    }

    #[test]
    fn raw_to_wad_xrp_realistic_high_price() {
        // XRP at $50.00: 5_000_000_000, scale=-8 → 5e9 × 10^10 = 5e19 = 50 WAD
        let raw = RawOracleData { asset_price: 5_000_000_000, scale: -8, last_update_time: 0 };
        let result = raw_to_wad(&raw).unwrap();
        assert_eq!(result, 50 * WAD);
    }

    // ── check_staleness ───────────────────────────────────────────────────────

    #[test]
    fn staleness_fresh_price_passes() {
        // Price updated 100s ago, max staleness 300s → ok
        let result = check_staleness(0, MAX_ORACLE_STALENESS_SECS, 100);
        assert!(result.is_ok());
    }

    #[test]
    fn staleness_exactly_at_limit_passes() {
        // Price updated exactly max_staleness seconds ago
        let result = check_staleness(0, MAX_ORACLE_STALENESS_SECS, MAX_ORACLE_STALENESS_SECS);
        assert!(result.is_ok(), "exactly at limit should pass");
    }

    #[test]
    fn staleness_one_second_over_fails() {
        // 301 seconds old with 300s limit → stale
        let result = check_staleness(0, MAX_ORACLE_STALENESS_SECS, MAX_ORACLE_STALENESS_SECS + 1);
        assert_eq!(result, Err(LendingError::OracleStale));
    }

    #[test]
    fn staleness_very_old_price_fails() {
        // 1-day old price → stale
        let result = check_staleness(0, MAX_ORACLE_STALENESS_SECS, 86_400);
        assert_eq!(result, Err(LendingError::OracleStale));
    }

    #[test]
    fn staleness_current_before_update_does_not_panic() {
        // current_time < last_update_time (clock skew) → saturating_sub → 0 → ok
        let result = check_staleness(1_000, MAX_ORACLE_STALENESS_SECS, 500);
        assert!(result.is_ok(), "clock skew should not error");
    }

    #[test]
    fn staleness_custom_max_staleness() {
        // Asset with stricter 60s staleness window
        assert!(check_staleness(0, 60, 60).is_ok());
        assert_eq!(check_staleness(0, 60, 61), Err(LendingError::OracleStale));
    }

    // ── RLUSD circuit breaker ─────────────────────────────────────────────────

    fn make_rlusd_reader(asset_price: u64) -> MockOracle {
        MockOracle {
            xrp: None,
            rlusd: Some(RawOracleData { asset_price, scale: -8, last_update_time: 0 }),
            wbtc: None,
        }
    }

    #[test]
    fn rlusd_at_exact_peg_returns_wad() {
        // $1.00 exactly
        let reader = make_rlusd_reader(100_000_000); // 1e8 × 10^(-8) = 1.0
        let price = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, WAD);
    }

    #[test]
    fn rlusd_just_inside_low_bound_returns_wad() {
        // $0.95 exactly (low_bound inclusive)
        // 0.95 × 10^8 = 95_000_000
        let reader = make_rlusd_reader(95_000_000);
        let price = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, WAD);
    }

    #[test]
    fn rlusd_just_inside_high_bound_returns_wad() {
        // $1.05 exactly (high_bound inclusive)
        // 1.05 × 10^8 = 105_000_000
        let reader = make_rlusd_reader(105_000_000);
        let price = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, WAD);
    }

    #[test]
    fn rlusd_below_low_bound_triggers_circuit_breaker() {
        // $0.94 < $0.95 → circuit breaker
        // 0.94 × 10^8 = 94_000_000
        let reader = make_rlusd_reader(94_000_000);
        let err = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleCircuitBreaker);
    }

    #[test]
    fn rlusd_above_high_bound_triggers_circuit_breaker() {
        // $1.06 > $1.05 → circuit breaker
        // 1.06 × 10^8 = 106_000_000
        let reader = make_rlusd_reader(106_000_000);
        let err = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleCircuitBreaker);
    }

    #[test]
    fn rlusd_stale_price_returns_oracle_stale() {
        // Fresh at t=0, current_time = 1000 > 300s max_staleness
        let reader = MockOracle {
            xrp: None,
            rlusd: Some(RawOracleData { asset_price: 100_000_000, scale: -8, last_update_time: 0 }),
            wbtc: None,
        };
        let err = get_rlusd_price(&reader, &RLUSD_ORACLE, 1000).unwrap_err();
        assert_eq!(err, LendingError::OracleStale);
    }

    #[test]
    fn rlusd_not_found_returns_asset_not_found() {
        let reader = MockOracle::empty();
        let err = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleAssetNotFound);
    }

    #[test]
    fn rlusd_always_returns_fixed_price_not_dia_value() {
        // $0.99 is inside bounds, but return value must be WAD (1.0), not 0.99 WAD
        let reader = make_rlusd_reader(99_000_000); // $0.99
        let price = get_rlusd_price(&reader, &RLUSD_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, WAD, "must return fixed 1.0 WAD, not DIA value");
        assert_ne!(price, WAD * 99 / 100, "must not return 0.99 WAD");
    }

    // ── get_asset_price ───────────────────────────────────────────────────────

    fn all_prices_reader() -> MockOracle {
        MockOracle::with_prices(XRP_PRICE, RLUSD_PRICE, BTC_PRICE)
    }

    #[test]
    fn get_asset_price_xrp_returns_correct_wad() {
        let reader = all_prices_reader();
        let price = get_asset_price(&reader, 0, &XRP_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, 2 * WAD, "XRP should be $2.00 = 2 WAD");
    }

    #[test]
    fn get_asset_price_rlusd_dispatches_to_circuit_breaker() {
        // RLUSD should return WAD (fixed price) not the raw DIA value
        let reader = all_prices_reader();
        let price = get_asset_price(&reader, 1, &RLUSD_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, WAD, "RLUSD should return fixed 1.0 WAD");
    }

    #[test]
    fn get_asset_price_wbtc_returns_correct_wad() {
        let reader = all_prices_reader();
        let price = get_asset_price(&reader, 2, &WBTC_ORACLE, CURRENT_TIME).unwrap();
        assert_eq!(price, 67_432 * WAD, "wBTC should be $67,432 = 67432 WAD");
    }

    #[test]
    fn get_asset_price_not_found_returns_error() {
        let reader = MockOracle::empty();
        let err = get_asset_price(&reader, 0, &XRP_ORACLE, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleAssetNotFound);
    }

    #[test]
    fn get_asset_price_stale_returns_error() {
        let reader = all_prices_reader();
        // current_time = 1000 > 300s (MAX_ORACLE_STALENESS_SECS)
        let err = get_asset_price(&reader, 0, &XRP_ORACLE, 1000).unwrap_err();
        assert_eq!(err, LendingError::OracleStale);
    }

    #[test]
    fn get_asset_price_rlusd_out_of_peg_returns_circuit_breaker() {
        let reader = MockOracle {
            xrp: Some(XRP_PRICE),
            rlusd: Some(RawOracleData { asset_price: 90_000_000, scale: -8, last_update_time: 0 }), // $0.90
            wbtc: Some(BTC_PRICE),
        };
        let err = get_asset_price(&reader, 1, &RLUSD_ORACLE, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleCircuitBreaker);
    }

    // ── get_all_prices ────────────────────────────────────────────────────────

    #[test]
    fn get_all_prices_happy_path() {
        let reader = all_prices_reader();
        let prices = get_all_prices(&reader, CURRENT_TIME).unwrap();

        assert_eq!(prices[0], 2 * WAD,        "XRP = $2.00");
        assert_eq!(prices[1], WAD,             "RLUSD = $1.00 (fixed)");
        assert_eq!(prices[2], 67_432 * WAD,    "wBTC = $67,432");
    }

    #[test]
    fn get_all_prices_xrp_missing_fails() {
        let reader = MockOracle {
            xrp: None,
            rlusd: Some(RLUSD_PRICE),
            wbtc: Some(BTC_PRICE),
        };
        let err = get_all_prices(&reader, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleAssetNotFound);
    }

    #[test]
    fn get_all_prices_rlusd_circuit_breaker_fails() {
        let reader = MockOracle {
            xrp: Some(XRP_PRICE),
            rlusd: Some(RawOracleData { asset_price: 80_000_000, scale: -8, last_update_time: 0 }), // $0.80
            wbtc: Some(BTC_PRICE),
        };
        let err = get_all_prices(&reader, CURRENT_TIME).unwrap_err();
        assert_eq!(err, LendingError::OracleCircuitBreaker);
    }

    #[test]
    fn get_all_prices_wbtc_stale_fails() {
        // Make wBTC stale: last_update_time=0, current_time=1000 > 300s
        let reader = MockOracle {
            xrp: Some(RawOracleData { asset_price: 200_000_000, scale: -8, last_update_time: 999 }),
            rlusd: Some(RawOracleData { asset_price: 100_000_000, scale: -8, last_update_time: 999 }),
            wbtc: Some(RawOracleData { asset_price: 6_743_200_000_000, scale: -8, last_update_time: 0 }),
        };
        let err = get_all_prices(&reader, 1000).unwrap_err();
        assert_eq!(err, LendingError::OracleStale);
    }

    #[test]
    fn get_all_prices_returns_three_nonzero() {
        let reader = all_prices_reader();
        let prices = get_all_prices(&reader, CURRENT_TIME).unwrap();
        for (i, &price) in prices.iter().enumerate() {
            assert!(price > 0, "price[{}] should be non-zero", i);
        }
    }

    // ── Integration / edge cases ──────────────────────────────────────────────

    #[test]
    fn pow10_table_spot_checks() {
        // Verify key entries
        assert_eq!(POW10[0], 1);
        assert_eq!(POW10[1], 10);
        assert_eq!(POW10[10], 10_000_000_000u128);
        assert_eq!(POW10[18], WAD);
    }

    #[test]
    fn pow10_table_is_monotone() {
        for i in 1..POW10.len() {
            assert_eq!(
                POW10[i],
                POW10[i - 1] * 10,
                "POW10[{}] should be 10 × POW10[{}]",
                i,
                i - 1
            );
        }
    }

    #[test]
    fn circuit_breaker_bounds_match_spec() {
        // low  = 9500 × WAD / 10000 = 0.95 WAD
        // high = 10500 × WAD / 10000 = 1.05 WAD
        let low: u128 = RLUSD_CB_LOW_BPS as u128 * WAD / BPS;
        let high: u128 = RLUSD_CB_HIGH_BPS as u128 * WAD / BPS;
        assert_eq!(low, WAD * 95 / 100, "low bound should be 0.95 WAD");
        assert_eq!(high, WAD * 105 / 100, "high bound should be 1.05 WAD");
        assert!(low < WAD, "low bound < 1.0 WAD");
        assert!(high > WAD, "high bound > 1.0 WAD");
    }

    #[test]
    fn xrp_price_scales_correctly_with_high_price() {
        // XRP at $10.00: 1_000_000_000 × 10^(-8) = 10.0 → 10 WAD
        let raw = RawOracleData { asset_price: 1_000_000_000, scale: -8, last_update_time: 0 };
        assert_eq!(raw_to_wad(&raw).unwrap(), 10 * WAD);
    }
}
