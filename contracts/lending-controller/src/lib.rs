#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

mod math;
mod errors;
mod state;
mod interest;
mod oracle;
mod health;
mod host;
mod supply;
mod collateral;
mod borrow;
mod liquidation;

// ── WASM entry points (compiled only for wasm32 target) ───────────────────────
//
// Each exported function:
//   1. Identifies the caller via `host::get_caller()`
//   2. Loads the required in-memory state from contract storage
//   3. Delegates to the appropriate handler in supply/collateral/borrow/liquidation
//   4. Persists mutated state back to storage
//   5. Calls `accept_tx()` on success or `rollback_tx(err)` on failure
//
// State layout (all keys are short ASCII byte slices, see state.rs):
//   "mkt:{i}:int:br"   → borrow_rate_bps (u64, 8 bytes)
//   "mkt:{i}:int:sr"   → supply_rate_bps (u64, 8 bytes)
//   "mkt:{i}:int:bi"   → borrow_index    (u128, 16 bytes)
//   "mkt:{i}:int:si"   → supply_index    (u128, 16 bytes)
//   "mkt:{i}:int:ts"   → last_update_timestamp (u64, 8 bytes)
//   "mkt:{i}:int:tb"   → total_borrows   (u128, 16 bytes)
//   "mkt:{i}:int:tp"   → total_supply    (u128, 16 bytes)
//   "pos:{20b}:{i}:co" → collateral      (u128, 16 bytes)
//   "pos:{20b}:{i}:de" → debt (scaled)   (u128, 16 bytes)
//   "pos:{20b}:{i}:bi" → user_borrow_index (u128, 16 bytes)
//   "pos:{20b}:{i}:sh" → supply_shares   (u128, 16 bytes)
//
// Vault accounts are stored in global keys:
//   "glb:vault0"  → vault account for XRP   (20 bytes)
//   "glb:vault1"  → vault account for RLUSD (20 bytes)
//   "glb:vault2"  → vault account for wBTC  (20 bytes)

#[cfg(target_arch = "wasm32")]
use crate::{
    borrow::{handle_borrow, handle_repay},
    collateral::{handle_deposit_collateral, handle_withdraw_collateral},
    errors::{LendingError, LendingResult},
    health::calculate_health_factor,
    host::{accept_tx, get_caller, read_state, rollback_tx, write_state, WasmHost, WasmOracle, HostContext},
    interest::get_actual_debt,
    liquidation::handle_liquidate,
    math::WAD,
    oracle::get_all_prices,
    state::{
        bytes_to_u128, bytes_to_u64, market_interest_key, u128_to_bytes, u64_to_bytes,
        user_position_key, global_key, InterestState, UserPositionForAsset, V1_MARKETS,
        NUM_V1_MARKETS, ASSET_DECIMALS,
    },
    supply::{handle_supply, handle_withdraw},
};

// ── State load / store helpers ────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
fn load_interest(asset_index: u8) -> InterestState {
    let mut s = InterestState::new();

    macro_rules! load_u128 {
        ($field:expr, $key:expr) => {{
            let (k, l) = market_interest_key(asset_index, $key);
            let mut buf = [0u8; 16];
            if read_state(&k[..l], &mut buf) == 16 {
                $field = bytes_to_u128(&buf);
            }
        }};
    }
    macro_rules! load_u64 {
        ($field:expr, $key:expr) => {{
            let (k, l) = market_interest_key(asset_index, $key);
            let mut buf = [0u8; 8];
            if read_state(&k[..l], &mut buf) == 8 {
                $field = bytes_to_u64(&buf);
            }
        }};
    }

    load_u64!(s.borrow_rate_bps, b"br");
    load_u64!(s.supply_rate_bps, b"sr");
    load_u128!(s.borrow_index, b"bi");
    load_u128!(s.supply_index, b"si");
    load_u64!(s.last_update_timestamp, b"ts");
    load_u128!(s.total_borrows, b"tb");
    load_u128!(s.total_supply, b"tp");
    // Ensure indexes are at least WAD (start value)
    if s.borrow_index == 0 { s.borrow_index = WAD; }
    if s.supply_index == 0 { s.supply_index = WAD; }
    s
}

#[cfg(target_arch = "wasm32")]
fn store_interest(asset_index: u8, s: &InterestState) {
    macro_rules! store_u128 {
        ($field:expr, $key:expr) => {{
            let (k, l) = market_interest_key(asset_index, $key);
            write_state(&k[..l], &u128_to_bytes($field));
        }};
    }
    macro_rules! store_u64 {
        ($field:expr, $key:expr) => {{
            let (k, l) = market_interest_key(asset_index, $key);
            write_state(&k[..l], &u64_to_bytes($field));
        }};
    }

    store_u64!(s.borrow_rate_bps, b"br");
    store_u64!(s.supply_rate_bps, b"sr");
    store_u128!(s.borrow_index, b"bi");
    store_u128!(s.supply_index, b"si");
    store_u64!(s.last_update_timestamp, b"ts");
    store_u128!(s.total_borrows, b"tb");
    store_u128!(s.total_supply, b"tp");
}

#[cfg(target_arch = "wasm32")]
fn load_all_interest() -> [InterestState; NUM_V1_MARKETS as usize] {
    [
        load_interest(0),
        load_interest(1),
        load_interest(2),
    ]
}

#[cfg(target_arch = "wasm32")]
fn store_all_interest(states: &[InterestState; NUM_V1_MARKETS as usize]) {
    for i in 0..NUM_V1_MARKETS as usize {
        store_interest(i as u8, &states[i]);
    }
}

#[cfg(target_arch = "wasm32")]
fn load_position(account: &[u8; 20]) -> [UserPositionForAsset; NUM_V1_MARKETS as usize] {
    let mut pos = [UserPositionForAsset::empty(); NUM_V1_MARKETS as usize];

    for i in 0..NUM_V1_MARKETS as usize {
        let mut buf16 = [0u8; 16];

        let (k, l) = user_position_key(account, i as u8, b"co");
        if read_state(&k[..l], &mut buf16) == 16 {
            pos[i].collateral = bytes_to_u128(&buf16);
        }
        let (k, l) = user_position_key(account, i as u8, b"de");
        if read_state(&k[..l], &mut buf16) == 16 {
            pos[i].debt = bytes_to_u128(&buf16);
        }
        let (k, l) = user_position_key(account, i as u8, b"bi");
        if read_state(&k[..l], &mut buf16) == 16 {
            pos[i].user_borrow_index = bytes_to_u128(&buf16);
        } else {
            pos[i].user_borrow_index = WAD;
        }
    }
    pos
}

#[cfg(target_arch = "wasm32")]
fn store_position(account: &[u8; 20], pos: &[UserPositionForAsset; NUM_V1_MARKETS as usize]) {
    for i in 0..NUM_V1_MARKETS as usize {
        let (k, l) = user_position_key(account, i as u8, b"co");
        write_state(&k[..l], &u128_to_bytes(pos[i].collateral));
        let (k, l) = user_position_key(account, i as u8, b"de");
        write_state(&k[..l], &u128_to_bytes(pos[i].debt));
        let (k, l) = user_position_key(account, i as u8, b"bi");
        write_state(&k[..l], &u128_to_bytes(pos[i].user_borrow_index));
    }
}

#[cfg(target_arch = "wasm32")]
fn load_supply_shares(account: &[u8; 20], asset_index: u8) -> u128 {
    let (k, l) = user_position_key(account, asset_index, b"sh");
    let mut buf = [0u8; 16];
    if read_state(&k[..l], &mut buf) == 16 { bytes_to_u128(&buf) } else { 0 }
}

#[cfg(target_arch = "wasm32")]
fn store_supply_shares(account: &[u8; 20], asset_index: u8, shares: u128) {
    let (k, l) = user_position_key(account, asset_index, b"sh");
    write_state(&k[..l], &u128_to_bytes(shares));
}

/// Load the supply vault account for `asset_index` from global state.
/// Falls back to a deterministic placeholder if not configured.
#[cfg(target_arch = "wasm32")]
fn load_vault_account(asset_index: u8) -> [u8; 20] {
    let key: &[u8] = match asset_index {
        0 => b"glb:vault0",
        1 => b"glb:vault1",
        _ => b"glb:vault2",
    };
    let (k, l) = global_key(&key[4..]); // strip "glb:" prefix since global_key adds it
    let mut buf = [0u8; 20];
    read_state(&k[..l], &mut buf);
    buf
}

// ── Exported entry points ─────────────────────────────────────────────────────

/// Supply `amount` native units of `asset_id` into the lending pool.
///
/// The asset must be attached to the ContractCall transaction.
/// The caller receives scaled supply shares tracked in contract state.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn supply(asset_id: u32, amount: u64) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }
        let caller = get_caller();
        let mut interest = load_interest(asset_index);
        let mut shares = load_supply_shares(&caller, asset_index);
        let vault = load_vault_account(asset_index);
        let mut ctx = WasmHost;
        let config = &V1_MARKETS[asset_index as usize];

        handle_supply(
            &mut ctx, config, amount as u128,
            &mut interest, &mut shares, &vault, asset_index,
        )?;

        store_interest(asset_index, &interest);
        store_supply_shares(&caller, asset_index, shares);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Withdraw `shares` (scaled) from the supply pool for `asset_id`.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn withdraw(asset_id: u32, shares: u64) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }
        let caller = get_caller();
        let mut interest = load_interest(asset_index);
        let mut user_shares = load_supply_shares(&caller, asset_index);
        let vault = load_vault_account(asset_index);
        let mut ctx = WasmHost;
        let config = &V1_MARKETS[asset_index as usize];

        handle_withdraw(
            &mut ctx, config, shares as u128,
            &caller, &mut interest, &mut user_shares, &vault, asset_index,
        )?;

        store_interest(asset_index, &interest);
        store_supply_shares(&caller, asset_index, user_shares);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Deposit `amount` native units of `asset_id` as collateral.
///
/// The asset must be attached to the ContractCall transaction.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn deposit_collateral(asset_id: u32, amount: u64) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }
        let caller = get_caller();
        let mut pos = load_position(&caller);
        let config = &V1_MARKETS[asset_index as usize];

        handle_deposit_collateral(config, amount as u128, &mut pos[asset_index as usize].collateral)?;

        store_position(&caller, &pos);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Withdraw `amount` native units of `asset_id` from collateral.
///
/// Enforces health factor ≥ 1.0 after withdrawal.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn withdraw_collateral(asset_id: u32, amount: u64) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }
        let caller = get_caller();
        let mut pos = load_position(&caller);
        let interest_states = load_all_interest();
        let oracle = WasmOracle;
        let mut ctx = WasmHost;

        handle_withdraw_collateral(
            &mut ctx, &oracle, &caller, asset_index, amount as u128,
            &mut pos, &interest_states, &V1_MARKETS,
        )?;

        store_position(&caller, &pos);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Borrow `amount` native units of `asset_id` from the lending pool.
///
/// Enforces LTV limits; sends the borrowed asset to the caller.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn borrow(asset_id: u32, amount: u64) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }
        let caller = get_caller();
        let mut pos = load_position(&caller);
        let mut market_interest = load_all_interest();
        let vault = load_vault_account(asset_index);
        let oracle = WasmOracle;
        let mut ctx = WasmHost;

        handle_borrow(
            &mut ctx, &oracle, &caller, asset_index, amount as u128,
            &mut pos, &mut market_interest, &V1_MARKETS, &vault,
        )?;

        store_position(&caller, &pos);
        store_all_interest(&market_interest);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Repay up to `amount` native units of the caller's debt in `asset_id`.
///
/// The asset must be attached to the ContractCall transaction.
/// Excess (overpayment) is refunded to the caller.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn repay(asset_id: u32, amount: u64) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }
        let caller = get_caller();
        let mut pos = load_position(&caller);
        let mut interest = load_interest(asset_index);
        let vault = load_vault_account(asset_index);
        let config = &V1_MARKETS[asset_index as usize];
        let mut ctx = WasmHost;

        handle_repay(
            &mut ctx, &caller, asset_index, amount as u128,
            &mut pos[asset_index as usize], &mut interest, config, &vault,
        )?;

        store_position(&caller, &pos);
        store_interest(asset_index, &interest);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Liquidate an undercollateralised borrower's position.
///
/// `borrower_ptr` — pointer to 20-byte XRPL AccountID in WASM memory.
/// `debt_id`      — asset index of the debt to repay.
/// `collat_id`    — asset index of the collateral to seize.
/// `amount`       — max debt (native units) the liquidator will repay.
///
/// The debt asset must be attached to the ContractCall transaction.
/// Seized collateral is sent to the caller (liquidator).
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn liquidate(
    borrower_ptr: u32,
    debt_id: u32,
    collat_id: u32,
    amount: u64,
) -> i32 {
    let result: LendingResult<()> = (|| {
        let debt_index = debt_id as u8;
        let col_index = collat_id as u8;
        if (debt_index as usize) >= NUM_V1_MARKETS as usize
            || (col_index as usize) >= NUM_V1_MARKETS as usize
        {
            return Err(LendingError::InvalidAsset);
        }

        // Read borrower AccountID from WASM linear memory
        let borrower: [u8; 20] = unsafe {
            let ptr = borrower_ptr as *const u8;
            let mut arr = [0u8; 20];
            core::ptr::copy_nonoverlapping(ptr, arr.as_mut_ptr(), 20);
            arr
        };

        let liquidator = get_caller();
        let mut pos = load_position(&borrower);
        let mut market_interest = load_all_interest();
        let vault = load_vault_account(debt_index);
        let oracle = WasmOracle;
        let mut ctx = WasmHost;

        handle_liquidate(
            &mut ctx, &oracle, &liquidator,
            debt_index, col_index, amount as u128,
            &mut pos, &mut market_interest, &V1_MARKETS, &vault,
        )?;

        store_position(&borrower, &pos);
        store_all_interest(&market_interest);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Register the calling account as the supply vault for `asset_id`.
///
/// Write-once: once a vault is set it cannot be overwritten.
/// The vault account must call this function itself (caller = vault account).
///
/// `asset_id` — 0=XRP, 1=RLUSD, 2=wBTC.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn set_vault(asset_id: u32) -> i32 {
    let result: LendingResult<()> = (|| {
        let asset_index = asset_id as u8;
        if (asset_index as usize) >= NUM_V1_MARKETS as usize {
            return Err(LendingError::InvalidAsset);
        }

        // Write-once protection: if already set, reject
        let existing = load_vault_account(asset_index);
        if existing != [0u8; 20] {
            return Err(LendingError::Unauthorized);
        }

        let caller = get_caller();
        let key: &[u8] = match asset_index {
            0 => b"vault0",
            1 => b"vault1",
            _ => b"vault2",
        };
        let (k, l) = global_key(key);
        write_state(&k[..l], &caller);
        Ok(())
    })();

    match result {
        Ok(()) => { accept_tx(); }
        Err(e) => { rollback_tx(e); }
    }
}

/// Return the health factor of `user` as a WAD-scaled u64.
///
/// `user_ptr` — pointer to 20-byte XRPL AccountID in WASM memory.
/// Returns WAD (1e18) = healthy, < WAD = liquidatable, u64::MAX = no debt.
/// Saturates to u64::MAX for the no-debt case.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn get_health_factor(user_ptr: u32) -> u64 {
    let user: [u8; 20] = unsafe {
        let ptr = user_ptr as *const u8;
        let mut arr = [0u8; 20];
        core::ptr::copy_nonoverlapping(ptr, arr.as_mut_ptr(), 20);
        arr
    };

    let pos = load_position(&user);
    let market_interest = load_all_interest();
    let oracle = WasmOracle;
    let ctx = WasmHost;

    // Compute actual positions (with accrued interest)
    let mut actual_pos = pos;
    for i in 0..NUM_V1_MARKETS as usize {
        if actual_pos[i].debt > 0 {
            if let Ok(d) = get_actual_debt(
                actual_pos[i].debt,
                actual_pos[i].user_borrow_index,
                market_interest[i].borrow_index,
            ) {
                actual_pos[i].debt = d;
            }
        }
    }

    let current_time = ctx.current_time();
    let prices = match get_all_prices(&oracle, current_time) {
        Ok(p) => p,
        Err(e) => { rollback_tx(e); }
    };

    let hf = match calculate_health_factor(&actual_pos, &prices, &V1_MARKETS) {
        Ok(h) => h,
        Err(e) => { rollback_tx(e); }
    };

    // Saturate u128 → u64 (u128::MAX → u64::MAX for no-debt case)
    hf.min(u64::MAX as u128) as u64
}

/// Serialize the user's position and write it to WASM memory via `set_return_value`.
///
/// `user_ptr` — pointer to 20-byte XRPL AccountID in WASM memory.
///
/// Output format (fixed, 120 bytes):
///   Per market (40 bytes each × 3 markets):
///     [0..16]  collateral (u128 LE)
///     [16..32] debt       (u128 LE, actual with interest)
///     [32..40] user_borrow_index (u64 LE — truncated WAD ratio)
///
/// The serialised blob is written via the `set_return_value` host function.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn get_user_position(user_ptr: u32) -> u32 {
    let user: [u8; 20] = unsafe {
        let ptr = user_ptr as *const u8;
        let mut arr = [0u8; 20];
        core::ptr::copy_nonoverlapping(ptr, arr.as_mut_ptr(), 20);
        arr
    };

    let pos = load_position(&user);
    let market_interest = load_all_interest();

    // Serialise: 3 markets × (collateral u128 + actual_debt u128 + supply_shares u128) = 3×48 = 144 bytes
    let mut buf = [0u8; 144];
    let mut offset = 0usize;

    for i in 0..NUM_V1_MARKETS as usize {
        let actual_debt = if pos[i].debt > 0 {
            get_actual_debt(
                pos[i].debt,
                pos[i].user_borrow_index,
                market_interest[i].borrow_index,
            )
            .unwrap_or(pos[i].debt)
        } else {
            0
        };

        buf[offset..offset + 16].copy_from_slice(&u128_to_bytes(pos[i].collateral));
        offset += 16;
        buf[offset..offset + 16].copy_from_slice(&u128_to_bytes(actual_debt));
        offset += 16;
        // Supply shares are loaded separately (user_position_key + "sh")
        let shares = load_supply_shares(&user, i as u8);
        buf[offset..offset + 16].copy_from_slice(&u128_to_bytes(shares));
        offset += 16;
    }

    unsafe { crate::host::set_return_value(buf.as_ptr(), buf.len() as u32) }

    buf.as_ptr() as u32
}
