// Borrow and repay logic

use crate::errors::{LendingError, LendingResult};
use crate::health::{asset_usd_value, calculate_borrow_capacity};
use crate::host::HostContext;
use crate::interest::{get_actual_debt, to_scaled_debt, update_interest_indexes};
use crate::oracle::{get_all_prices, LedgerReader};
use crate::state::{
    ASSET_DECIMALS, InterestState, MarketConfig, UserPositionForAsset, NUM_V1_MARKETS,
};

// ── Public API ────────────────────────────────────────────────────────────────

/// Borrow `amount` native units of `asset_index` from the supply vault.
///
/// Flow:
///   1. Validate + update interest for borrowed market
///   2. Compute actual positions (accrued debt across all markets)
///   3. Fetch oracle prices, check borrow capacity
///   4. Check vault liquidity
///   5. Withdraw from vault, send to caller
///   6. Update user debt (merge with existing, re-normalise)
///   7. Update market totals
///
/// # Errors
/// - `InvalidAmount` if amount == 0
/// - `BorrowNotEnabled` if borrowing is disabled for this market
/// - `BorrowCapacityExceeded` if the USD value of the borrow > available capacity
/// - `InsufficientBorrowLiquidity` if vault cash < amount
/// - Oracle errors propagated from `get_all_prices`
pub fn handle_borrow<H: HostContext, L: LedgerReader>(
    ctx: &mut H,
    oracle: &L,
    caller: &[u8; 20],
    asset_index: u8,
    amount: u128,
    user_position: &mut [UserPositionForAsset; NUM_V1_MARKETS as usize],
    market_interest: &mut [InterestState; NUM_V1_MARKETS as usize],
    all_configs: &[MarketConfig; NUM_V1_MARKETS as usize],
    vault_account: &[u8; 20],
) -> LendingResult<()> {
    if amount == 0 {
        return Err(LendingError::InvalidAmount);
    }
    let idx = asset_index as usize;
    let config = &all_configs[idx];

    if !config.borrow_enabled {
        return Err(LendingError::BorrowNotEnabled);
    }

    // 1. Update interest for the borrowed market
    let current_time = ctx.current_time();
    market_interest[idx] =
        update_interest_indexes(market_interest[idx], config, current_time)?;

    // 2. Build actual positions with interest-adjusted debt
    let mut actual_positions = *user_position;
    for i in 0..NUM_V1_MARKETS as usize {
        if actual_positions[i].debt > 0 {
            actual_positions[i].debt = get_actual_debt(
                actual_positions[i].debt,
                actual_positions[i].user_borrow_index,
                market_interest[i].borrow_index,
            )?;
        }
    }

    // 3. Compute borrow capacity and compare
    let prices = get_all_prices(oracle, current_time)?;
    let capacity_usd = calculate_borrow_capacity(&actual_positions, &prices, all_configs)?;
    let amount_usd = asset_usd_value(
        amount,
        prices[idx],
        ASSET_DECIMALS[idx],
    )?;
    if amount_usd > capacity_usd {
        return Err(LendingError::BorrowCapacityExceeded);
    }

    // 4. Check vault cash
    if amount > market_interest[idx].total_supply {
        return Err(LendingError::InsufficientBorrowLiquidity);
    }

    // 5. Withdraw from vault and forward to caller
    ctx.vault_withdraw(vault_account, asset_index, amount)?;
    ctx.transfer_to(caller, asset_index, amount)?;

    // 6. Merge new borrow with existing debt (re-normalise to current index)
    let existing_actual = if user_position[idx].debt > 0 {
        get_actual_debt(
            user_position[idx].debt,
            user_position[idx].user_borrow_index,
            market_interest[idx].borrow_index,
        )?
    } else {
        0
    };
    let new_actual = existing_actual
        .checked_add(amount)
        .ok_or(LendingError::MathOverflow)?;
    let new_principal = to_scaled_debt(new_actual, market_interest[idx].borrow_index)?;

    user_position[idx].debt = new_principal;
    user_position[idx].user_borrow_index = market_interest[idx].borrow_index;

    // 7. Update market totals
    market_interest[idx].total_borrows = market_interest[idx].total_borrows
        .checked_add(amount)
        .ok_or(LendingError::MathOverflow)?;
    market_interest[idx].total_supply =
        market_interest[idx].total_supply.saturating_sub(amount);

    Ok(())
}

/// Repay up to `amount` native units of the caller's debt in `asset_index`.
///
/// `amount` is the quantity the caller has attached to the ContractCall.
/// If `amount > actual_debt`, the excess is refunded to `caller`.
///
/// Flow:
///   1. Validate + update interest
///   2. Compute actual debt (with accrued interest)
///   3. Deposit min(amount, actual_debt) into vault
///   4. Refund any excess
///   5. Update user position and market totals
///
/// # Errors
/// - `InvalidAmount` if amount == 0
/// - `NoBorrowBalance` if the user has no outstanding debt
pub fn handle_repay<H: HostContext>(
    ctx: &mut H,
    caller: &[u8; 20],
    asset_index: u8,
    amount: u128,
    user_pos: &mut UserPositionForAsset,
    interest: &mut InterestState,
    config: &MarketConfig,
    vault_account: &[u8; 20],
) -> LendingResult<()> {
    if amount == 0 {
        return Err(LendingError::InvalidAmount);
    }
    if user_pos.debt == 0 {
        return Err(LendingError::NoBorrowBalance);
    }

    // 1. Update interest so borrow_index is current
    let current_time = ctx.current_time();
    *interest = update_interest_indexes(*interest, config, current_time)?;

    // 2. Compute actual debt
    let actual_debt = get_actual_debt(
        user_pos.debt,
        user_pos.user_borrow_index,
        interest.borrow_index,
    )?;

    // 3. Repay at most actual_debt
    let repay_amount = amount.min(actual_debt);
    let excess = amount - repay_amount;

    // 4. Deposit repay amount into vault
    ctx.vault_deposit(vault_account, asset_index, repay_amount)?;

    // 5. Refund any overpayment
    if excess > 0 {
        ctx.transfer_to(caller, asset_index, excess)?;
    }

    // 6. Update user position
    let remaining = actual_debt - repay_amount;
    if remaining == 0 {
        user_pos.debt = 0;
        user_pos.user_borrow_index = interest.borrow_index;
    } else {
        user_pos.debt = to_scaled_debt(remaining, interest.borrow_index)?;
        user_pos.user_borrow_index = interest.borrow_index;
    }

    // 7. Update market totals
    interest.total_borrows = interest.total_borrows.saturating_sub(repay_amount);
    interest.total_supply = interest.total_supply
        .checked_add(repay_amount)
        .ok_or(LendingError::MathOverflow)?;

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;
    use crate::oracle::RawOracleData;
    use crate::state::{
        InterestState, UserPositionForAsset, V1_MARKETS,
        TICKER_BTC_HEX, TICKER_RLUSD_HEX, TICKER_XRP_HEX,
        ASSET_XRP, ASSET_RLUSD, NUM_V1_MARKETS, RLUSD_MARKET, XRP_MARKET,
    };

    // ── MockHost ──────────────────────────────────────────────────────────────

    struct MockHost {
        time: u64,
        vault_balance: u128,              // single-asset vault for simplicity
        last_transfer: Option<(u8, u128)>,
        last_vault_deposit: Option<u128>,
    }

    impl MockHost {
        fn new(time: u64, vault_balance: u128) -> Self {
            MockHost { time, vault_balance, last_transfer: None, last_vault_deposit: None }
        }
    }

    impl HostContext for MockHost {
        fn current_time(&self) -> u64 { self.time }

        fn vault_deposit(&mut self, _v: &[u8; 20], _a: u8, amount: u128) -> LendingResult<()> {
            self.vault_balance += amount;
            self.last_vault_deposit = Some(amount);
            Ok(())
        }

        fn vault_withdraw(&mut self, _v: &[u8; 20], _a: u8, amount: u128) -> LendingResult<()> {
            if self.vault_balance < amount {
                return Err(LendingError::InsufficientBorrowLiquidity);
            }
            self.vault_balance -= amount;
            Ok(())
        }

        fn transfer_to(&mut self, _to: &[u8; 20], asset: u8, amount: u128) -> LendingResult<()> {
            self.last_transfer = Some((asset, amount));
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

    fn default_oracle(time: u64) -> MockOracle {
        MockOracle {
            xrp_price_wad: 2 * WAD,       // XRP  $2.00
            rlusd_price_wad: WAD,          // RLUSD $1.00
            wbtc_price_wad: 60_000 * WAD,  // BTC $60,000
            time,
        }
    }

    fn fresh_interest_arr() -> [InterestState; 3] {
        [InterestState::new(); 3]
    }

    fn empty_positions() -> [UserPositionForAsset; 3] {
        [UserPositionForAsset::empty(); 3]
    }

    const CALLER: [u8; 20] = [0x03u8; 20];
    const VAULT: [u8; 20] = [0xBBu8; 20];

    // ── handle_borrow tests ───────────────────────────────────────────────────

    #[test]
    fn borrow_zero_rejected() {
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 0);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();

        let err = handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 0,
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    #[test]
    fn borrow_disabled_rejected() {
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 100_000_000_000);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();

        let mut configs = V1_MARKETS;
        configs[ASSET_RLUSD as usize].borrow_enabled = false;

        pos[0].collateral = 10_000_000_000u128; // 10,000 XRP

        let err = handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 1_000_000,
            &mut pos, &mut interest, &configs, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::BorrowNotEnabled);
    }

    #[test]
    fn borrow_exceeds_capacity_rejected() {
        // 100 RLUSD collateral (ltv=80%) → capacity = $80 → borrow $100 RLUSD fails
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 1_000_000_000_000);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();
        interest[1].total_supply = 1_000_000_000_000;

        pos[1].collateral = 100_000_000u128; // 100 RLUSD

        let err = handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 100_000_000, // borrow 100 RLUSD
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::BorrowCapacityExceeded);
    }

    #[test]
    fn borrow_insufficient_liquidity_rejected() {
        // Enough capacity but vault has no cash
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 0); // empty vault
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();
        interest[1].total_supply = 0; // no liquidity

        pos[1].collateral = 10_000_000_000u128; // 10,000 RLUSD

        let err = handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 1_000_000, // 1 RLUSD
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InsufficientBorrowLiquidity);
    }

    #[test]
    fn borrow_happy_path() {
        // 10,000 RLUSD collateral (ltv=80%) → capacity $8,000 → borrow 5,000 RLUSD
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 5_000_000_000_000);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();
        interest[1].total_supply = 5_000_000_000; // 5000 RLUSD available

        pos[1].collateral = 10_000_000_000u128; // 10,000 RLUSD

        handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 5_000_000_000, // 5,000 RLUSD
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        // Asset sent to caller
        assert_eq!(ctx.last_transfer, Some((ASSET_RLUSD, 5_000_000_000u128)));
        // Debt recorded
        assert!(pos[1].debt > 0);
        assert_eq!(pos[1].user_borrow_index, WAD);
    }

    #[test]
    fn borrow_normalizes_debt() {
        // At borrow_index = WAD, scaled_principal = amount
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 1_000_000_000_000);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();
        interest[1].total_supply = 1_000_000_000;

        pos[1].collateral = 5_000_000_000u128;

        let borrow_amount = 1_000_000_000u128; // 1000 RLUSD
        handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, borrow_amount,
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        // to_scaled_debt(amount, WAD) = amount * WAD / WAD = amount
        assert_eq!(pos[1].debt, borrow_amount);
    }

    #[test]
    fn borrow_updates_market_totals() {
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 1_000_000_000_000);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();
        interest[1].total_supply = 2_000_000_000u128;

        pos[1].collateral = 5_000_000_000u128;
        let borrow_amount = 1_000_000_000u128;

        handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, borrow_amount,
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        assert_eq!(interest[1].total_borrows, borrow_amount);
        assert_eq!(interest[1].total_supply, 1_000_000_000u128); // 2000 - 1000
    }

    #[test]
    fn borrow_adds_to_existing_debt() {
        // User already has 500 RLUSD debt, borrows 300 more
        let oracle = default_oracle(1000);
        let mut ctx = MockHost::new(1000, 1_000_000_000_000);
        let mut pos = empty_positions();
        let mut interest = fresh_interest_arr();
        interest[1].total_supply = 1_000_000_000u128;

        pos[1].collateral = 5_000_000_000u128;
        pos[1].debt = 500_000_000u128; // 500 RLUSD stored at index=WAD
        pos[1].user_borrow_index = WAD;
        interest[1].total_borrows = 500_000_000;

        handle_borrow(
            &mut ctx, &oracle, &CALLER, ASSET_RLUSD, 300_000_000,
            &mut pos, &mut interest, &V1_MARKETS, &VAULT,
        )
        .unwrap();

        // new total actual = 500 + 300 = 800 RLUSD → stored at index=WAD → 800_000_000
        assert_eq!(pos[1].debt, 800_000_000u128);
        assert_eq!(interest[1].total_borrows, 800_000_000u128);
    }

    // ── handle_repay tests ────────────────────────────────────────────────────

    #[test]
    fn repay_zero_rejected() {
        let mut ctx = MockHost::new(1000, 0);
        let mut pos = UserPositionForAsset {
            debt: 1_000_000,
            collateral: 0,
            user_borrow_index: WAD,
        };
        let mut interest = InterestState::new();

        let err = handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, 0,
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    #[test]
    fn repay_no_debt_rejected() {
        let mut ctx = MockHost::new(1000, 0);
        let mut pos = UserPositionForAsset::empty();
        let mut interest = InterestState::new();

        let err = handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, 1_000_000,
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::NoBorrowBalance);
    }

    #[test]
    fn repay_full_debt() {
        // Repay exactly actual_debt → debt cleared
        let mut ctx = MockHost::new(1000, 0);
        let debt = 1_000_000_000u128; // 1000 RLUSD
        let mut pos = UserPositionForAsset {
            debt,
            collateral: 0,
            user_borrow_index: WAD,
        };
        let mut interest = InterestState::new();
        interest.total_borrows = debt;

        handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, debt,
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap();

        assert_eq!(pos.debt, 0);
        assert_eq!(interest.total_borrows, 0);
        assert_eq!(interest.total_supply, debt);
        assert_eq!(ctx.last_vault_deposit, Some(debt));
    }

    #[test]
    fn repay_partial() {
        let mut ctx = MockHost::new(1000, 0);
        let debt = 2_000_000_000u128;
        let mut pos = UserPositionForAsset {
            debt,
            collateral: 0,
            user_borrow_index: WAD,
        };
        let mut interest = InterestState::new();
        interest.total_borrows = debt;

        let repay = 500_000_000u128;
        handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, repay,
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap();

        // remaining debt = 2000 - 500 = 1500 RLUSD (scaled at WAD)
        assert_eq!(pos.debt, 1_500_000_000u128);
        assert_eq!(interest.total_borrows, 1_500_000_000u128);
    }

    #[test]
    fn repay_overpayment_refunded() {
        // User sends 2000 RLUSD but only owes 1000 → 1000 refunded
        let mut ctx = MockHost::new(1000, 0);
        let debt = 1_000_000_000u128;
        let mut pos = UserPositionForAsset {
            debt,
            collateral: 0,
            user_borrow_index: WAD,
        };
        let mut interest = InterestState::new();
        interest.total_borrows = debt;

        handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, 2_000_000_000, // 2000 RLUSD sent
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap();

        assert_eq!(pos.debt, 0);
        // Excess 1000 RLUSD refunded
        assert_eq!(ctx.last_transfer, Some((ASSET_RLUSD, 1_000_000_000u128)));
    }

    #[test]
    fn repay_accrued_interest() {
        // Stored principal = 1000 RLUSD at borrow_index = WAD
        // borrow_index now = 1.5 × WAD → actual_debt = 1500 RLUSD
        // Repay 1500 → full repay
        let mut ctx = MockHost::new(1000, 0);
        let principal = 1_000_000_000u128;
        let mut pos = UserPositionForAsset {
            debt: principal,
            collateral: 0,
            user_borrow_index: WAD,
        };
        let mut interest = InterestState::new();
        interest.borrow_index = WAD + WAD / 2; // 1.5 WAD
        interest.total_borrows = 1_500_000_000u128; // matches actual_debt

        // Repay actual_debt = 1500
        handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, 1_500_000_000,
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap();

        assert_eq!(pos.debt, 0);
        assert_eq!(ctx.last_vault_deposit, Some(1_500_000_000u128));
        // No refund expected
        assert!(ctx.last_transfer.is_none());
    }

    #[test]
    fn repay_updates_market_totals() {
        let mut ctx = MockHost::new(1000, 0);
        let debt = 3_000_000_000u128;
        let mut pos = UserPositionForAsset { debt, collateral: 0, user_borrow_index: WAD };
        let mut interest = InterestState::new();
        interest.total_borrows = debt;
        interest.total_supply = 0;

        let repay = 1_000_000_000u128;
        handle_repay(
            &mut ctx, &CALLER, ASSET_RLUSD, repay,
            &mut pos, &mut interest, &RLUSD_MARKET, &VAULT,
        )
        .unwrap();

        assert_eq!(interest.total_borrows, 2_000_000_000u128);
        assert_eq!(interest.total_supply, repay);
    }
}
