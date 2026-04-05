// Liquidation: trigger conditions, bonus calculation, execution
//
// A liquidation repays part of an unhealthy borrower's debt and seizes
// their collateral (plus a bonus) in return. Close factor = 50%.

use crate::errors::{LendingError, LendingResult};
use crate::health::{
    asset_usd_value, calculate_health_factor, calculate_liquidation_amounts, is_liquidatable,
};
use crate::host::HostContext;
use crate::interest::{get_actual_debt, to_scaled_debt, update_interest_indexes};
use crate::oracle::{get_all_prices, LedgerReader};
use crate::state::{
    ASSET_DECIMALS, InterestState, MarketConfig, UserPositionForAsset, NUM_V1_MARKETS,
};

// ── Result ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationResult {
    /// Actual debt repaid by the liquidator (native units of debt asset).
    pub debt_repaid: u128,
    /// Total collateral seized from the borrower (native units, incl. bonus).
    pub collateral_seized: u128,
    /// Bonus portion of the seized collateral (native units).
    pub bonus: u128,
    /// Borrower's health factor after the liquidation (WAD-scaled).
    pub new_health_factor: u128,
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Liquidate an unhealthy position.
///
/// The liquidator repays up to 50% of the borrower's total USD-denominated debt
/// for a single debt asset, and seizes collateral (plus a liquidation bonus)
/// denominated in a (potentially different) collateral asset.
///
/// # Arguments
/// * `liquidator`        – account paying the debt
/// * `debt_asset_index`  – which V1 asset the liquidator is repaying
/// * `col_asset_index`   – which V1 asset to seize as collateral
/// * `amount`            – max debt amount the liquidator wants to repay (native)
/// * `borrower_position` – full position of the borrower (mutable)
/// * `market_interest`   – interest states for all markets (mutable)
/// * `configs`           – risk parameters for all markets
/// * `vault_account`     – supply vault for the debt asset
///
/// # Errors
/// * `InvalidAmount` – amount == 0
/// * `InvalidLiquidation` – same asset for debt and collateral
/// * `PositionHealthy` – borrower's HF ≥ 1.0
/// * `InsufficientCollateralToSeize` – borrower has less collateral than needed
/// * Oracle errors propagated from `get_all_prices`
pub fn handle_liquidate<H: HostContext, L: LedgerReader>(
    ctx: &mut H,
    oracle: &L,
    liquidator: &[u8; 20],
    debt_asset_index: u8,
    col_asset_index: u8,
    amount: u128,
    borrower_position: &mut [UserPositionForAsset; NUM_V1_MARKETS as usize],
    market_interest: &mut [InterestState; NUM_V1_MARKETS as usize],
    configs: &[MarketConfig; NUM_V1_MARKETS as usize],
    vault_account: &[u8; 20],
) -> LendingResult<LiquidationResult> {
    if amount == 0 {
        return Err(LendingError::InvalidAmount);
    }
    if debt_asset_index == col_asset_index {
        return Err(LendingError::InvalidLiquidation);
    }

    let d = debt_asset_index as usize;
    let c = col_asset_index as usize;
    let current_time = ctx.current_time();

    // ── a. Update interest indexes for both markets ─────────────────────────
    market_interest[d] =
        update_interest_indexes(market_interest[d], &configs[d], current_time)?;
    market_interest[c] =
        update_interest_indexes(market_interest[c], &configs[c], current_time)?;

    // ── b. Compute actual debts across all markets ──────────────────────────
    let mut actual_positions = *borrower_position;
    for i in 0..NUM_V1_MARKETS as usize {
        if actual_positions[i].debt > 0 {
            actual_positions[i].debt = get_actual_debt(
                actual_positions[i].debt,
                actual_positions[i].user_borrow_index,
                market_interest[i].borrow_index,
            )?;
        }
    }

    // ── c. Check borrower is liquidatable (HF < 1.0) ───────────────────────
    let prices = get_all_prices(oracle, current_time)?;
    let hf = calculate_health_factor(&actual_positions, &prices, configs)?;
    if !is_liquidatable(hf) {
        return Err(LendingError::PositionHealthy);
    }

    // ── d. Cap to 50% of total USD debt (close factor) ──────────────────────
    let actual_debt_in_asset = actual_positions[d].debt;
    if actual_debt_in_asset == 0 {
        return Err(LendingError::NoBorrowBalance);
    }

    // Total debt in USD across all markets
    let mut total_debt_usd: u128 = 0;
    for i in 0..NUM_V1_MARKETS as usize {
        if actual_positions[i].debt > 0 {
            total_debt_usd = total_debt_usd
                .checked_add(asset_usd_value(
                    actual_positions[i].debt,
                    prices[i],
                    ASSET_DECIMALS[i],
                )?)
                .ok_or(LendingError::MathOverflow)?;
        }
    }
    // max_repay_usd = 50% of total debt
    let max_repay_usd = total_debt_usd * 5_000 / 10_000;

    // Convert amount to USD and cap
    let amount_usd = asset_usd_value(amount, prices[d], ASSET_DECIMALS[d])?;
    let debt_asset_usd = asset_usd_value(actual_debt_in_asset, prices[d], ASSET_DECIMALS[d])?;

    // Effective repay is capped by: amount, actual debt in this asset, and 50% close factor
    let effective_usd = amount_usd.min(max_repay_usd).min(debt_asset_usd);

    // Convert back to native units:  native = usd / (price / 10^decimals) = usd / price_per_native
    let debt_price_per_native = prices[d] / crate::oracle::POW10[ASSET_DECIMALS[d] as usize];
    if debt_price_per_native == 0 {
        return Err(LendingError::OraclePriceZero);
    }
    let debt_repaid = effective_usd / debt_price_per_native;
    if debt_repaid == 0 {
        return Err(LendingError::InvalidAmount);
    }

    // ── e-f. Compute collateral to seize (including bonus) ──────────────────
    let (col_to_seize, bonus) = calculate_liquidation_amounts(
        debt_repaid,
        prices[d],
        prices[c],
        configs[c].liquidation_bonus,
        ASSET_DECIMALS[d],
        ASSET_DECIMALS[c],
    )?;

    // ── g. Verify borrower has enough collateral ────────────────────────────
    if col_to_seize > actual_positions[c].collateral {
        return Err(LendingError::InsufficientCollateralToSeize);
    }

    // ── h. Execute transactions ─────────────────────────────────────────────
    // Liquidator sends debt_repaid → vault
    ctx.vault_deposit(vault_account, debt_asset_index, debt_repaid)?;
    // Contract sends seized collateral → liquidator
    ctx.transfer_to(liquidator, col_asset_index, col_to_seize)?;

    // ── i. Update borrower state ────────────────────────────────────────────
    // Reduce debt
    let remaining_debt = actual_debt_in_asset.saturating_sub(debt_repaid);
    if remaining_debt == 0 {
        borrower_position[d].debt = 0;
    } else {
        borrower_position[d].debt =
            to_scaled_debt(remaining_debt, market_interest[d].borrow_index)?;
    }
    borrower_position[d].user_borrow_index = market_interest[d].borrow_index;

    // Reduce collateral
    borrower_position[c].collateral = borrower_position[c]
        .collateral
        .saturating_sub(col_to_seize);

    // Update market totals
    market_interest[d].total_borrows =
        market_interest[d].total_borrows.saturating_sub(debt_repaid);
    market_interest[d].total_supply = market_interest[d]
        .total_supply
        .checked_add(debt_repaid)
        .ok_or(LendingError::MathOverflow)?;

    // ── j. Compute post-liquidation HF ──────────────────────────────────────
    let mut post_positions = *borrower_position;
    for i in 0..NUM_V1_MARKETS as usize {
        if post_positions[i].debt > 0 {
            post_positions[i].debt = get_actual_debt(
                post_positions[i].debt,
                post_positions[i].user_borrow_index,
                market_interest[i].borrow_index,
            )?;
        }
    }
    let new_hf = calculate_health_factor(&post_positions, &prices, configs)?;

    Ok(LiquidationResult {
        debt_repaid,
        collateral_seized: col_to_seize,
        bonus,
        new_health_factor: new_hf,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;
    use crate::oracle::RawOracleData;
    use crate::state::{
        InterestState, UserPositionForAsset, V1_MARKETS, TICKER_BTC_HEX, TICKER_RLUSD_HEX,
        TICKER_XRP_HEX, ASSET_RLUSD, ASSET_WBTC,
    };

    // ── MockHost ──────────────────────────────────────────────────────────────

    struct MockHost {
        time: u64,
        last_vault_deposit: Option<(u8, u128)>,
        last_transfer: Option<(u8, u128)>,
    }

    impl MockHost {
        fn new(time: u64) -> Self {
            MockHost { time, last_vault_deposit: None, last_transfer: None }
        }
    }

    impl HostContext for MockHost {
        fn current_time(&self) -> u64 { self.time }

        fn vault_deposit(&mut self, _v: &[u8; 20], a: u8, amt: u128) -> LendingResult<()> {
            self.last_vault_deposit = Some((a, amt));
            Ok(())
        }
        fn vault_withdraw(&mut self, _v: &[u8; 20], _a: u8, _amt: u128) -> LendingResult<()> {
            Ok(())
        }
        fn transfer_to(&mut self, _to: &[u8; 20], a: u8, amt: u128) -> LendingResult<()> {
            self.last_transfer = Some((a, amt));
            Ok(())
        }
    }

    // ── MockOracle ────────────────────────────────────────────────────────────

    struct MockOracle {
        xrp_price_wad: u128,
        rlusd_price_wad: u128,
        wbtc_price_wad: u128,
        time: u64,
    }

    impl LedgerReader for MockOracle {
        fn read_oracle_price(
            &self,
            _account: &[u8; 20],
            _doc_id: u32,
            ticker: &[u8; 20],
        ) -> Option<RawOracleData> {
            let price_wad = if ticker == &TICKER_XRP_HEX {
                self.xrp_price_wad
            } else if ticker == &TICKER_RLUSD_HEX {
                self.rlusd_price_wad
            } else if ticker == &TICKER_BTC_HEX {
                self.wbtc_price_wad
            } else {
                return None;
            };
            Some(RawOracleData {
                asset_price: (price_wad / 10_000_000_000u128) as u64,
                scale: -8,
                last_update_time: self.time,
            })
        }
    }

    fn oracle_at(time: u64, wbtc_price: u128) -> MockOracle {
        MockOracle {
            xrp_price_wad: 2 * WAD,
            rlusd_price_wad: WAD,         // triggers circuit breaker → 1.0 WAD
            wbtc_price_wad: wbtc_price,
            time,
        }
    }

    fn empty_positions() -> [UserPositionForAsset; 3] {
        [UserPositionForAsset::empty(); 3]
    }

    fn fresh_interest_arr() -> [InterestState; 3] {
        [InterestState::new(); 3]
    }

    const LIQUIDATOR: [u8; 20] = [0x04u8; 20];
    const VAULT: [u8; 20] = [0xCCu8; 20];

    // ── Scenario: Alice has 1 wBTC ($60k), 48000 RLUSD debt ─────────────────
    //
    // wBTC liqThreshold = 78%
    // weighted col = 60000 * 0.78 = 46800 USD
    // debt = 48000 USD
    // HF = 46800 / 48000 = 0.975 (< 1.0 → liquidatable)

    fn alice_underwater() -> ([UserPositionForAsset; 3], [InterestState; 3]) {
        let mut pos = empty_positions();
        // 1 BTC = 100_000_000 satoshis
        pos[ASSET_WBTC as usize].collateral = 100_000_000u128;
        // 48,000 RLUSD (6 decimals) = 48_000_000_000
        pos[ASSET_RLUSD as usize].debt = 48_000_000_000u128;
        pos[ASSET_RLUSD as usize].user_borrow_index = WAD;

        let mut interest = fresh_interest_arr();
        interest[ASSET_RLUSD as usize].total_borrows = 48_000_000_000;
        interest[ASSET_RLUSD as usize].total_supply = 100_000_000_000; // plenty of liquidity

        (pos, interest)
    }

    // ── Full scenario: Bob liquidates 50% ────────────────────────────────────

    #[test]
    fn full_liquidation_scenario() {
        let (mut pos, mut interest) = alice_underwater();
        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        // Bob sends 24,000 RLUSD (50% of 48,000)
        let result = handle_liquidate(
            &mut ctx,
            &oracle,
            &LIQUIDATOR,
            ASSET_RLUSD,    // debt asset
            ASSET_WBTC,     // collateral asset
            24_000_000_000, // 24,000 RLUSD
            &mut pos,
            &mut interest,
            &V1_MARKETS,
            &VAULT,
        )
        .unwrap();

        // debt_repaid = 24,000 RLUSD
        assert_eq!(result.debt_repaid, 24_000_000_000u128);

        // collateral_seized:
        //   debt_usd = 24000 * $1.00 = $24,000
        //   seize_usd = $24000 * (10000+650)/10000 = $25,560
        //   col_price_per_sat = 60000e18 / 1e8 = 6e14
        //   col_to_seize = 25560e18 / 6e14 = 42_600_000 sats (0.426 BTC)
        assert_eq!(result.collateral_seized, 42_600_000u128);

        // bonus = 42_600_000 - 40_000_000 = 2_600_000 sats
        assert_eq!(result.bonus, 2_600_000u128);

        // Bob's profit in USD:
        //   received 0.426 BTC = $25,560
        //   paid 24,000 RLUSD = $24,000
        //   profit ≈ $1,560

        // Alice's new HF should be > 1.0
        assert!(result.new_health_factor > WAD,
            "Alice HF should recover above 1.0, got {}",
            result.new_health_factor);

        // Verify state mutations
        assert_eq!(pos[ASSET_WBTC as usize].collateral, 100_000_000 - 42_600_000);
        // debt went from 48000 to 24000 RLUSD
        let remaining_actual = get_actual_debt(
            pos[ASSET_RLUSD as usize].debt,
            pos[ASSET_RLUSD as usize].user_borrow_index,
            interest[ASSET_RLUSD as usize].borrow_index,
        )
        .unwrap();
        assert_eq!(remaining_actual, 24_000_000_000u128);

        // Verify host calls
        assert_eq!(ctx.last_vault_deposit, Some((ASSET_RLUSD, 24_000_000_000u128)));
        assert_eq!(ctx.last_transfer, Some((ASSET_WBTC, 42_600_000u128)));
    }

    // ── Healthy position → PositionHealthy ──────────────────────────────────

    #[test]
    fn liquidation_healthy_position_reverts() {
        let mut pos = empty_positions();
        // 1 BTC collateral, only 10,000 RLUSD debt → HF >> 1
        pos[ASSET_WBTC as usize].collateral = 100_000_000u128;
        pos[ASSET_RLUSD as usize].debt = 10_000_000_000u128;
        pos[ASSET_RLUSD as usize].user_borrow_index = WAD;

        let mut interest = fresh_interest_arr();
        interest[ASSET_RLUSD as usize].total_borrows = 10_000_000_000;
        interest[ASSET_RLUSD as usize].total_supply = 100_000_000_000;

        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        let err = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            5_000_000_000, &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::PositionHealthy);
    }

    // ── Liquidation > 50% → capped at 50% ──────────────────────────────────

    #[test]
    fn liquidation_capped_at_50_percent() {
        let (mut pos, mut interest) = alice_underwater();
        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        // Bob tries to repay ALL 48,000 RLUSD → should be capped to 24,000
        let result = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            48_000_000_000, // full debt
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        // Capped to 50% = 24,000 RLUSD
        assert_eq!(result.debt_repaid, 24_000_000_000u128);
    }

    // ── Insufficient collateral ─────────────────────────────────────────────

    #[test]
    fn liquidation_insufficient_collateral_reverts() {
        let mut pos = empty_positions();
        // Tiny collateral: 0.001 BTC = 100_000 sats, but large RLUSD debt
        // At $60k/BTC: col = $60, liqThresh=78%: weighted=$46.8
        // debt = 100 RLUSD = $100 → HF = 46.8/100 = 0.468 → liquidatable
        // But repaying 50 RLUSD → seize_usd = 50 * 1.065 = $53.25
        // col_to_seize = $53.25 / ($60000/1e8) = 53.25 / 0.0006 = 88_750 sats
        // borrower only has 100_000 sats → enough
        //
        // Instead, make debt much larger relative to tiny collateral
        pos[ASSET_WBTC as usize].collateral = 1_000u128;      // 0.00001 BTC = $0.60
        pos[ASSET_RLUSD as usize].debt = 1_000_000u128;       // 1 RLUSD = $1
        pos[ASSET_RLUSD as usize].user_borrow_index = WAD;

        let mut interest = fresh_interest_arr();
        interest[ASSET_RLUSD as usize].total_borrows = 1_000_000;
        interest[ASSET_RLUSD as usize].total_supply = 100_000_000;

        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        // Repay 0.5 RLUSD = 500_000 (50% of 1 RLUSD)
        // seize_usd = $0.50 * 1.065 = $0.5325
        // col_per_sat = 60000e18 / 1e8 = 6e14
        // col_to_seize = 0.5325e18 / 6e14 = 887 sats
        // borrower has 1000 sats → enough
        //
        // To trigger InsufficientCollateralToSeize, we need col_to_seize > collateral.
        // Set collateral to just 500 sats:
        pos[ASSET_WBTC as usize].collateral = 500u128;

        let err = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            500_000, // 0.5 RLUSD
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InsufficientCollateralToSeize);
    }

    // ── Oracle stale → error propagated ─────────────────────────────────────

    #[test]
    fn liquidation_oracle_stale_reverts() {
        let (mut pos, mut interest) = alice_underwater();
        // Oracle time = 0, current_time = 1000 → staleness 1000 > max 300
        let oracle = oracle_at(0, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        let err = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            24_000_000_000, &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::OracleStale);
    }

    // ── Same asset → InvalidLiquidation ─────────────────────────────────────

    #[test]
    fn liquidation_same_asset_reverts() {
        let (mut pos, mut interest) = alice_underwater();
        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        let err = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_RLUSD,
            1_000_000, &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InvalidLiquidation);
    }

    // ── Zero amount → InvalidAmount ─────────────────────────────────────────

    #[test]
    fn liquidation_zero_amount_reverts() {
        let (mut pos, mut interest) = alice_underwater();
        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        let err = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            0, &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    // ── Small liquidation (< 50%) ───────────────────────────────────────────

    #[test]
    fn liquidation_partial_below_max() {
        let (mut pos, mut interest) = alice_underwater();
        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        // Liquidate only 10,000 RLUSD (< 50% of 48,000)
        let result = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            10_000_000_000, // 10,000 RLUSD
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        assert_eq!(result.debt_repaid, 10_000_000_000u128);

        // collateral_seized:
        //   debt_usd = $10,000
        //   seize_usd = $10,000 * 1.065 = $10,650
        //   col_to_seize = $10,650 / ($60k/1e8) = 10650e18 / 6e14 = 17_750_000 sats
        assert_eq!(result.collateral_seized, 17_750_000u128);
    }

    // ── Market totals updated correctly ─────────────────────────────────────

    #[test]
    fn liquidation_updates_market_totals() {
        let (mut pos, mut interest) = alice_underwater();
        let original_borrows = interest[ASSET_RLUSD as usize].total_borrows;
        let original_supply = interest[ASSET_RLUSD as usize].total_supply;
        let oracle = oracle_at(1000, 60_000 * WAD);
        let mut ctx = MockHost::new(1000);

        let result = handle_liquidate(
            &mut ctx, &oracle, &LIQUIDATOR, ASSET_RLUSD, ASSET_WBTC,
            24_000_000_000, &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        let repaid = result.debt_repaid;
        assert_eq!(interest[ASSET_RLUSD as usize].total_borrows, original_borrows - repaid);
        assert_eq!(interest[ASSET_RLUSD as usize].total_supply, original_supply + repaid);
    }
}
