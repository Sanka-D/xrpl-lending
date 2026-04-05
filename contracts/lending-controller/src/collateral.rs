// Collateral management: deposit and withdraw with HF enforcement

use crate::errors::{LendingError, LendingResult};
use crate::health::{asset_usd_value, calculate_health_factor, is_liquidatable};
use crate::host::HostContext;
use crate::interest::get_actual_debt;
use crate::oracle::{get_all_prices, LedgerReader};
use crate::state::{InterestState, MarketConfig, UserPositionForAsset, NUM_V1_MARKETS};

// ── Public API ────────────────────────────────────────────────────────────────

/// Credit `amount` native units of `asset_index` as collateral for the caller.
///
/// The asset is already held by the contract account (attached to the ContractCall).
/// This function validates and updates accounting only.
///
/// # Errors
/// - `InvalidAmount` if amount == 0
/// - `CollateralNotEnabled` if the asset is not accepted as collateral
pub fn handle_deposit_collateral(
    config: &MarketConfig,
    amount: u128,
    user_collateral: &mut u128,
) -> LendingResult<()> {
    if amount == 0 {
        return Err(LendingError::InvalidAmount);
    }
    if !config.collateral_enabled {
        return Err(LendingError::CollateralNotEnabled);
    }
    *user_collateral = user_collateral
        .checked_add(amount)
        .ok_or(LendingError::MathOverflow)?;
    Ok(())
}

/// Withdraw `amount` native units of `asset_index` collateral back to `caller`.
///
/// Simulates the post-withdrawal position and rejects if HF would drop below 1.0.
///
/// # Errors
/// - `InvalidAmount` if amount == 0
/// - `InsufficientCollateral` if user's deposited collateral < amount
/// - `WithdrawWouldLiquidate` if HF < 1.0 after the withdrawal
/// - Oracle errors propagated from `get_all_prices`
pub fn handle_withdraw_collateral<H: HostContext, L: LedgerReader>(
    ctx: &mut H,
    oracle: &L,
    caller: &[u8; 20],
    asset_index: u8,
    amount: u128,
    user_position: &mut [UserPositionForAsset; NUM_V1_MARKETS as usize],
    interest_states: &[InterestState; NUM_V1_MARKETS as usize],
    configs: &[MarketConfig; NUM_V1_MARKETS as usize],
) -> LendingResult<()> {
    if amount == 0 {
        return Err(LendingError::InvalidAmount);
    }
    let idx = asset_index as usize;
    if user_position[idx].collateral < amount {
        return Err(LendingError::InsufficientCollateral);
    }

    // Simulate post-withdrawal positions with actual (interest-adjusted) debt
    let mut post = *user_position;
    post[idx].collateral -= amount;
    for i in 0..NUM_V1_MARKETS as usize {
        if post[i].debt > 0 {
            post[i].debt = get_actual_debt(
                post[i].debt,
                post[i].user_borrow_index,
                interest_states[i].borrow_index,
            )?;
        }
    }

    // Fetch oracle prices and compute post-withdrawal HF
    let current_time = ctx.current_time();
    let prices = get_all_prices(oracle, current_time)?;
    let hf = calculate_health_factor(&post, &prices, configs)?;
    if is_liquidatable(hf) {
        return Err(LendingError::WithdrawWouldLiquidate);
    }

    // Commit withdrawal
    user_position[idx].collateral -= amount;
    ctx.transfer_to(caller, asset_index, amount)?;

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;
    use crate::oracle::RawOracleData;
    use crate::state::{
        InterestState, UserPositionForAsset, V1_MARKETS, WBTC_MARKET, XRP_MARKET, RLUSD_MARKET,
        TICKER_BTC_HEX, TICKER_RLUSD_HEX, TICKER_XRP_HEX,
        ASSET_XRP, ASSET_RLUSD, ASSET_WBTC, NUM_V1_MARKETS,
    };

    // ── MockHost ──────────────────────────────────────────────────────────────

    struct MockHost {
        time: u64,
        last_transfer: Option<([u8; 20], u8, u128)>,
    }

    impl MockHost {
        fn new(time: u64) -> Self { MockHost { time, last_transfer: None } }
    }

    impl HostContext for MockHost {
        fn current_time(&self) -> u64 { self.time }

        fn vault_deposit(&mut self, _v: &[u8; 20], _a: u8, _amt: u128) -> LendingResult<()> {
            Ok(())
        }
        fn vault_withdraw(&mut self, _v: &[u8; 20], _a: u8, _amt: u128) -> LendingResult<()> {
            Ok(())
        }
        fn transfer_to(&mut self, to: &[u8; 20], asset: u8, amount: u128) -> LendingResult<()> {
            self.last_transfer = Some((*to, asset, amount));
            Ok(())
        }
    }

    // ── MockOracle ────────────────────────────────────────────────────────────
    // Uses scale=-8 so  price_wad = asset_price × 10^10
    // → asset_price = price_wad / 10^10

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

    fn default_oracle(time: u64) -> MockOracle {
        MockOracle {
            xrp_price_wad: 2 * WAD,        // XRP  $2.00
            rlusd_price_wad: WAD,           // RLUSD $1.00 (triggers circuit breaker → 1.0 WAD)
            wbtc_price_wad: 60_000 * WAD,   // BTC $60,000
            time,
        }
    }

    fn fresh_interest() -> InterestState { InterestState::new() }

    fn empty_positions() -> [UserPositionForAsset; 3] {
        [UserPositionForAsset::empty(); 3]
    }

    fn fresh_interest_states() -> [InterestState; 3] {
        [InterestState::new(); 3]
    }

    const CALLER: [u8; 20] = [0x02u8; 20];

    // ── handle_deposit_collateral ─────────────────────────────────────────────

    #[test]
    fn deposit_zero_rejected() {
        let mut col = 0u128;
        let err = handle_deposit_collateral(&XRP_MARKET, 0, &mut col).unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    #[test]
    fn deposit_collateral_disabled_rejected() {
        let mut disabled = XRP_MARKET;
        disabled.collateral_enabled = false;
        let mut col = 0u128;
        let err = handle_deposit_collateral(&disabled, 1_000_000, &mut col).unwrap_err();
        assert_eq!(err, LendingError::CollateralNotEnabled);
    }

    #[test]
    fn deposit_happy_path() {
        let mut col = 0u128;
        handle_deposit_collateral(&XRP_MARKET, 1_000_000, &mut col).unwrap();
        assert_eq!(col, 1_000_000);
    }

    #[test]
    fn deposit_accumulates() {
        let mut col = 0u128;
        handle_deposit_collateral(&XRP_MARKET, 1_000_000, &mut col).unwrap();
        handle_deposit_collateral(&XRP_MARKET, 2_000_000, &mut col).unwrap();
        assert_eq!(col, 3_000_000);
    }

    // ── handle_withdraw_collateral ────────────────────────────────────────────

    #[test]
    fn withdraw_zero_rejected() {
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        let interest = fresh_interest_states();

        let err = handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_XRP, 0,
            &mut pos, &interest, &V1_MARKETS,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    #[test]
    fn withdraw_exceeds_balance_rejected() {
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        pos[0].collateral = 500_000;
        let interest = fresh_interest_states();

        let err = handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_XRP, 1_000_000,
            &mut pos, &interest, &V1_MARKETS,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InsufficientCollateral);
    }

    #[test]
    fn withdraw_no_debt_always_ok() {
        // No debt → HF = u128::MAX → always OK
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        pos[0].collateral = 10_000_000; // 10 XRP
        let interest = fresh_interest_states();

        handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_XRP, 5_000_000,
            &mut pos, &interest, &V1_MARKETS,
        )
        .unwrap();

        assert_eq!(pos[0].collateral, 5_000_000);
        assert_eq!(ctx.last_transfer, Some((CALLER, ASSET_XRP, 5_000_000u128)));
    }

    #[test]
    fn withdraw_happy_path_healthy() {
        // Deposit 10,000 RLUSD collateral, borrow 5,000 RLUSD
        // liqThreshold RLUSD = 85%: HF before = 10000*0.85/5000 = 1.7
        // Withdraw 3,000 RLUSD → post collateral = 7,000
        // post HF = 7000*0.85/5000 = 1.19 > 1.0 → OK
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        pos[1].collateral = 10_000_000_000u128; // 10,000 RLUSD
        pos[1].debt = 5_000_000_000u128;        // 5,000 RLUSD (scaled principal at index=WAD)
        pos[1].user_borrow_index = WAD;
        let interest = fresh_interest_states();

        handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 3_000_000_000,
            &mut pos, &interest, &V1_MARKETS,
        )
        .unwrap();

        assert_eq!(pos[1].collateral, 7_000_000_000u128);
    }

    #[test]
    fn withdraw_would_liquidate_rejected() {
        // Deposit 10,000 RLUSD, borrow 9,000 RLUSD
        // liqThreshold = 85%: HF = 10000*0.85/9000 ≈ 0.944 (already under 1.0!)
        // But at deposit time we allow it by directly setting debt > LTV.
        // Withdraw 1 unit → post collateral = 9999.999999 RLUSD
        // post HF = ~9999.999999 * 0.85 / 9000 ≈ 0.944 → liquidatable
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        pos[1].collateral = 10_000_000_000u128; // 10,000 RLUSD
        pos[1].debt = 9_000_000_000u128;        // 9,000 RLUSD
        pos[1].user_borrow_index = WAD;
        let interest = fresh_interest_states();

        let err = handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 1,
            &mut pos, &interest, &V1_MARKETS,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::WithdrawWouldLiquidate);
    }

    #[test]
    fn withdraw_sends_asset_to_caller() {
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        pos[0].collateral = 5_000_000; // 5 XRP, no debt

        let interest = fresh_interest_states();
        handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_XRP, 2_000_000,
            &mut pos, &interest, &V1_MARKETS,
        )
        .unwrap();

        assert_eq!(ctx.last_transfer, Some((CALLER, ASSET_XRP, 2_000_000u128)));
    }

    #[test]
    fn withdraw_with_accrued_interest_accounted() {
        // User has scaled debt at borrow_index = WAD.
        // Over time, borrow_index doubles → actual_debt doubles.
        // With collateral=20,000 and actual_debt=10,000 (liqThresh=85%):
        //   HF = 20000*0.85/10000 = 1.7 → healthy
        // Withdraw 5,000 → post col = 15,000
        //   HF = 15000*0.85/10000 = 1.275 → still healthy
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000);
        let mut pos = empty_positions();
        pos[1].collateral = 20_000_000_000u128; // 20,000 RLUSD
        pos[1].debt = 5_000_000_000u128;        // stored principal = 5,000 (at borrow_index=WAD)
        pos[1].user_borrow_index = WAD;

        // borrow_index doubled → actual_debt = 5000 * 2 = 10,000
        let mut interest_states = fresh_interest_states();
        interest_states[1].borrow_index = WAD * 2;

        handle_withdraw_collateral(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 5_000_000_000,
            &mut pos, &interest_states, &V1_MARKETS,
        )
        .unwrap();

        assert_eq!(pos[1].collateral, 15_000_000_000u128);
    }
}
