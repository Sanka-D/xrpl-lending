// Supply (deposit) and withdraw logic
//
// Uses Aave-style scaled balances:
//   scaled_shares = wad_div(amount, supply_index)   on deposit
//   amount        = wad_mul(shares, supply_index)   on redeem
//
// `total_supply` in InterestState tracks available cash in the vault
// (increases on deposit/repay, decreases on withdraw/borrow).

use crate::errors::{LendingError, LendingResult};
use crate::host::HostContext;
use crate::interest::update_interest_indexes;
use crate::math::{wad_div, wad_mul};
use crate::state::{InterestState, MarketConfig};

// ── Public API ────────────────────────────────────────────────────────────────

/// Deposit `amount` native units into the supply vault for `asset_index`.
///
/// Mints scaled supply shares:  `scaled_shares = amount × WAD / supply_index`
///
/// # State mutations
/// - `interest` updated (indexes, rates, timestamp)
/// - `interest.total_supply += amount`
/// - `user_supply_shares += scaled_shares`
pub fn handle_supply<H: HostContext>(
    ctx: &mut H,
    config: &MarketConfig,
    amount: u128,
    interest: &mut InterestState,
    user_supply_shares: &mut u128,
    vault_account: &[u8; 20],
    asset_index: u8,
) -> LendingResult<()> {
    if amount == 0 {
        return Err(LendingError::InvalidAmount);
    }

    // Accrue interest so supply_index is current before share calculation
    *interest = update_interest_indexes(*interest, config, ctx.current_time())?;

    // Scaled shares = amount × WAD / supply_index
    let scaled_shares = wad_div(amount, interest.supply_index)
        .ok_or(LendingError::MathOverflow)?;

    // Forward asset to vault (emits VaultDeposit in production)
    ctx.vault_deposit(vault_account, asset_index, amount)?;

    // Credit user and update vault balance
    *user_supply_shares = user_supply_shares
        .checked_add(scaled_shares)
        .ok_or(LendingError::MathOverflow)?;
    interest.total_supply = interest.total_supply
        .checked_add(amount)
        .ok_or(LendingError::MathOverflow)?;

    Ok(())
}

/// Redeem `shares` (scaled) from the supply vault and transfer underlying to `caller`.
///
/// Underlying = `shares × supply_index / WAD`
///
/// # Errors
/// - `InvalidAmount` if shares == 0
/// - `WithdrawExceedsBalance` if user's share balance is insufficient
/// - `InsufficientLiquidity` if vault cash < redeemed amount (borrows crowd out)
pub fn handle_withdraw<H: HostContext>(
    ctx: &mut H,
    config: &MarketConfig,
    shares: u128,
    caller: &[u8; 20],
    interest: &mut InterestState,
    user_supply_shares: &mut u128,
    vault_account: &[u8; 20],
    asset_index: u8,
) -> LendingResult<()> {
    if shares == 0 {
        return Err(LendingError::InvalidAmount);
    }
    if shares > *user_supply_shares {
        return Err(LendingError::WithdrawExceedsBalance);
    }

    // Accrue interest so supply_index is current
    *interest = update_interest_indexes(*interest, config, ctx.current_time())?;

    // Underlying amount = shares × supply_index / WAD
    let amount = wad_mul(shares, interest.supply_index)
        .ok_or(LendingError::MathOverflow)?;

    // total_supply is the available cash; borrows have already been subtracted
    if amount > interest.total_supply {
        return Err(LendingError::InsufficientLiquidity);
    }

    // Withdraw from vault and send to caller
    ctx.vault_withdraw(vault_account, asset_index, amount)?;
    ctx.transfer_to(caller, asset_index, amount)?;

    // Burn shares and reduce cash balance
    *user_supply_shares -= shares;
    interest.total_supply -= amount;

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;
    use crate::state::XRP_MARKET;

    // ── MockHost ──────────────────────────────────────────────────────────────

    struct MockHost {
        time: u64,
        vault_balances: [u128; 3],
        last_transfer: Option<(u8, u128)>, // (asset_index, amount)
    }

    impl MockHost {
        fn new(time: u64) -> Self {
            MockHost { time, vault_balances: [0; 3], last_transfer: None }
        }
    }

    impl HostContext for MockHost {
        fn current_time(&self) -> u64 { self.time }

        fn vault_deposit(&mut self, _vault: &[u8; 20], asset_index: u8, amount: u128)
            -> LendingResult<()>
        {
            self.vault_balances[asset_index as usize] += amount;
            Ok(())
        }

        fn vault_withdraw(&mut self, _vault: &[u8; 20], asset_index: u8, amount: u128)
            -> LendingResult<()>
        {
            if self.vault_balances[asset_index as usize] < amount {
                return Err(LendingError::InsufficientLiquidity);
            }
            self.vault_balances[asset_index as usize] -= amount;
            Ok(())
        }

        fn transfer_to(&mut self, _to: &[u8; 20], asset_index: u8, amount: u128)
            -> LendingResult<()>
        {
            self.last_transfer = Some((asset_index, amount));
            Ok(())
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn fresh_interest() -> InterestState {
        InterestState::new()
    }

    const VAULT: [u8; 20] = [0xAAu8; 20];
    const CALLER: [u8; 20] = [0x01u8; 20];

    // ── handle_supply tests ───────────────────────────────────────────────────

    #[test]
    fn supply_zero_amount_rejected() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        let mut shares = 0u128;
        let err = handle_supply(&mut ctx, &XRP_MARKET, 0, &mut interest, &mut shares, &VAULT, 0)
            .unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    #[test]
    fn supply_happy_path() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        let mut shares = 0u128;
        let amount = 1_000_000_000u128; // 1000 XRP in drops

        handle_supply(&mut ctx, &XRP_MARKET, amount, &mut interest, &mut shares, &VAULT, 0)
            .unwrap();

        // At supply_index = WAD, shares = amount (1:1)
        assert_eq!(shares, amount);
        assert_eq!(interest.total_supply, amount);
        assert_eq!(ctx.vault_balances[0], amount);
    }

    #[test]
    fn supply_updates_total_supply() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        let mut shares = 0u128;

        handle_supply(&mut ctx, &XRP_MARKET, 5_000_000, &mut interest, &mut shares, &VAULT, 0)
            .unwrap();
        handle_supply(&mut ctx, &XRP_MARKET, 3_000_000, &mut interest, &mut shares, &VAULT, 0)
            .unwrap();

        assert_eq!(interest.total_supply, 8_000_000);
    }

    #[test]
    fn supply_accrues_interest_first() {
        let mut ctx = MockHost::new(10_000); // timestamp 10_000
        let mut interest = fresh_interest();
        interest.last_update_timestamp = 0;
        interest.borrow_rate_bps = 400; // 4% APY
        interest.total_borrows = 500_000_000;
        interest.total_supply = 500_000_000;
        let mut shares = 0u128;

        handle_supply(&mut ctx, &XRP_MARKET, 1_000_000, &mut interest, &mut shares, &VAULT, 0)
            .unwrap();

        // Timestamp should be updated
        assert_eq!(interest.last_update_timestamp, 10_000);
    }

    #[test]
    fn supply_shares_scale_with_index() {
        // When supply_index > WAD, same deposit mints fewer shares
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        interest.supply_index = WAD * 2; // 2× index (accumulated 100% interest)
        let mut shares = 0u128;

        let amount = 1_000_000u128;
        handle_supply(&mut ctx, &XRP_MARKET, amount, &mut interest, &mut shares, &VAULT, 0)
            .unwrap();

        // shares = amount * WAD / (2 * WAD) = amount / 2
        assert_eq!(shares, amount / 2);
    }

    // ── handle_withdraw tests ─────────────────────────────────────────────────

    #[test]
    fn withdraw_zero_shares_rejected() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        let mut shares = 1_000_000u128;
        let err = handle_withdraw(
            &mut ctx, &XRP_MARKET, 0, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InvalidAmount);
    }

    #[test]
    fn withdraw_exceeds_balance_rejected() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        let mut shares = 500_000u128;
        let err = handle_withdraw(
            &mut ctx, &XRP_MARKET, 1_000_000, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::WithdrawExceedsBalance);
    }

    #[test]
    fn withdraw_insufficient_liquidity() {
        // total_supply < redeemed amount (most is borrowed out)
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        interest.total_supply = 100_000u128; // only 0.1 XRP available
        ctx.vault_balances[0] = 100_000;
        let mut shares = 1_000_000u128;
        // At supply_index = WAD, 1_000_000 shares → 1_000_000 underlying
        let err = handle_withdraw(
            &mut ctx, &XRP_MARKET, 1_000_000, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap_err();
        assert_eq!(err, LendingError::InsufficientLiquidity);
    }

    #[test]
    fn withdraw_happy_path() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        interest.total_supply = 1_000_000u128;
        ctx.vault_balances[0] = 1_000_000;
        let mut shares = 1_000_000u128;

        handle_withdraw(
            &mut ctx, &XRP_MARKET, 1_000_000, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap();

        assert_eq!(shares, 0);
        assert_eq!(interest.total_supply, 0);
        assert_eq!(ctx.last_transfer, Some((0u8, 1_000_000u128)));
    }

    #[test]
    fn withdraw_reduces_total_supply() {
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        interest.total_supply = 2_000_000u128;
        ctx.vault_balances[0] = 2_000_000;
        let mut shares = 2_000_000u128;

        handle_withdraw(
            &mut ctx, &XRP_MARKET, 500_000, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap();

        assert_eq!(interest.total_supply, 1_500_000);
        assert_eq!(shares, 1_500_000);
    }

    #[test]
    fn supply_withdraw_roundtrip() {
        // Supply then immediately withdraw same amount — should get same amount back
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        let mut shares = 0u128;
        let amount = 5_000_000u128;

        handle_supply(&mut ctx, &XRP_MARKET, amount, &mut interest, &mut shares, &VAULT, 0)
            .unwrap();

        // Shares minted at supply_index = WAD → shares == amount
        let minted = shares;
        handle_withdraw(
            &mut ctx, &XRP_MARKET, minted, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap();

        // At the same supply_index, shares × index / WAD == original amount
        assert_eq!(ctx.last_transfer, Some((0u8, amount)));
        assert_eq!(shares, 0);
        assert_eq!(interest.total_supply, 0);
    }

    #[test]
    fn withdraw_amount_scales_with_index() {
        // At 2× supply_index, each share redeems double the underlying
        let mut ctx = MockHost::new(1000);
        let mut interest = fresh_interest();
        interest.supply_index = WAD * 2;
        interest.total_supply = 2_000_000u128;
        ctx.vault_balances[0] = 2_000_000;
        let mut shares = 1_000_000u128; // user has 1_000_000 scaled shares

        handle_withdraw(
            &mut ctx, &XRP_MARKET, 1_000_000, &CALLER, &mut interest,
            &mut shares, &VAULT, 0,
        )
        .unwrap();

        // amount = 1_000_000 × 2 WAD / WAD = 2_000_000
        assert_eq!(ctx.last_transfer, Some((0u8, 2_000_000u128)));
    }
}
