/// XRPL host context — abstracts ledger write operations.
///
/// Production (WASM): methods call XLS-101 host functions to emit transactions
///                     and read ledger objects.
/// Tests (native): backed by `MockHost` with in-memory state.

use crate::errors::{LendingError, LendingResult};

// ── Trait ─────────────────────────────────────────────────────────────────────

pub(crate) trait HostContext {
    /// Current ledger close time in UNIX seconds.
    fn current_time(&self) -> u64;

    /// Deposit `amount` native units of `asset_index` into an XLS-65 supply vault.
    fn vault_deposit(
        &mut self,
        vault: &[u8; 20],
        asset_index: u8,
        amount: u128,
    ) -> LendingResult<()>;

    /// Withdraw `amount` native units of `asset_index` from an XLS-65 supply vault.
    fn vault_withdraw(
        &mut self,
        vault: &[u8; 20],
        asset_index: u8,
        amount: u128,
    ) -> LendingResult<()>;

    /// Transfer `amount` native units of `asset_index` from the contract to `recipient`.
    fn transfer_to(
        &mut self,
        recipient: &[u8; 20],
        asset_index: u8,
        amount: u128,
    ) -> LendingResult<()>;
}

// ── XLS-101 WASM host functions ───────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
extern "C" {
    /// Ledger close time of the parent ledger (UNIX seconds, since Ripple epoch).
    fn ledger_time() -> i64;

    /// Write the caller's 20-byte AccountID into `buf`. Returns 20 on success.
    fn caller_account(buf: *mut u8) -> i32;

    /// Read a value from contract state.
    /// Returns the number of bytes read, or -1 if the key is not found.
    fn state_read(
        key_ptr: *const u8,
        key_len: u32,
        val_ptr: *mut u8,
        val_len: u32,
    ) -> i32;

    /// Write a value to contract state. Returns 0 on success.
    fn state_write(
        key_ptr: *const u8,
        key_len: u32,
        val_ptr: *const u8,
        val_len: u32,
    ) -> i32;

    /// Emit a Payment from the contract account to `dest`.
    /// `asset_id` selects the currency (0=XRP native, 1=RLUSD token, 2=wBTC token).
    /// `amount_hi`/`amount_lo` encode u128 as two u64s.
    fn emit_payment(dest: *const u8, asset_id: u32, amount_hi: u64, amount_lo: u64) -> i32;

    /// Emit an XLS-65 VaultDeposit to `vault`.
    fn emit_vault_deposit(vault: *const u8, asset_id: u32, amount_hi: u64, amount_lo: u64) -> i32;

    /// Emit an XLS-65 VaultWithdraw from `vault`.
    fn emit_vault_withdraw(vault: *const u8, asset_id: u32, amount_hi: u64, amount_lo: u64) -> i32;

    /// Read a DIA oracle price entry.
    /// Writes `AssetPrice` (u64), `Scale` (i8), `LastUpdateTime` (u64) into the
    /// provided output buffers. Returns 0 on success, -1 if not found.
    fn read_oracle_price_entry(
        oracle_account: *const u8,
        document_id: u32,
        asset_ticker: *const u8,
        out_price: *mut u64,
        out_scale: *mut i8,
        out_time: *mut u64,
    ) -> i32;

    /// Set the return value blob for read-only queries.
    pub(crate) fn set_return_value(ptr: *const u8, len: u32);

    /// Accept the transaction (success).
    fn accept(msg_ptr: *const u8, msg_len: u32, code: i64) -> !;

    /// Rollback the transaction (revert all state changes).
    fn rollback(msg_ptr: *const u8, msg_len: u32, code: i64) -> !;
}

// ── WASM helper wrappers ──────────────────────────────────────────────────────

/// Split a u128 into (hi, lo) u64 pair for host function calls.
#[cfg(target_arch = "wasm32")]
#[inline]
fn split_u128(v: u128) -> (u64, u64) {
    ((v >> 64) as u64, v as u64)
}

/// Get the caller's 20-byte AccountID.
#[cfg(target_arch = "wasm32")]
pub(crate) fn get_caller() -> [u8; 20] {
    let mut buf = [0u8; 20];
    unsafe { caller_account(buf.as_mut_ptr()); }
    buf
}

/// Read a value from contract state. Returns number of bytes read, 0 if not found.
#[cfg(target_arch = "wasm32")]
pub(crate) fn read_state(key: &[u8], val: &mut [u8]) -> usize {
    let r = unsafe { state_read(key.as_ptr(), key.len() as u32, val.as_mut_ptr(), val.len() as u32) };
    if r < 0 { 0 } else { r as usize }
}

/// Write a value to contract state.
#[cfg(target_arch = "wasm32")]
pub(crate) fn write_state(key: &[u8], val: &[u8]) {
    unsafe { state_write(key.as_ptr(), key.len() as u32, val.as_ptr(), val.len() as u32); }
}

// ── WasmHost : HostContext ────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
pub(crate) struct WasmHost;

#[cfg(target_arch = "wasm32")]
impl HostContext for WasmHost {
    fn current_time(&self) -> u64 {
        // XRPL epoch is 2000-01-01, but we use raw ledger seconds everywhere.
        let t = unsafe { ledger_time() };
        if t < 0 { 0 } else { t as u64 }
    }

    fn vault_deposit(
        &mut self,
        vault: &[u8; 20],
        asset_index: u8,
        amount: u128,
    ) -> LendingResult<()> {
        let (hi, lo) = split_u128(amount);
        let r = unsafe { emit_vault_deposit(vault.as_ptr(), asset_index as u32, hi, lo) };
        if r != 0 { Err(LendingError::InsufficientLiquidity) } else { Ok(()) }
    }

    fn vault_withdraw(
        &mut self,
        vault: &[u8; 20],
        asset_index: u8,
        amount: u128,
    ) -> LendingResult<()> {
        let (hi, lo) = split_u128(amount);
        let r = unsafe { emit_vault_withdraw(vault.as_ptr(), asset_index as u32, hi, lo) };
        if r != 0 { Err(LendingError::InsufficientBorrowLiquidity) } else { Ok(()) }
    }

    fn transfer_to(
        &mut self,
        recipient: &[u8; 20],
        asset_index: u8,
        amount: u128,
    ) -> LendingResult<()> {
        let (hi, lo) = split_u128(amount);
        let r = unsafe { emit_payment(recipient.as_ptr(), asset_index as u32, hi, lo) };
        if r != 0 { Err(LendingError::InsufficientLiquidity) } else { Ok(()) }
    }
}

// ── WasmOracle : LedgerReader ─────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
pub(crate) struct WasmOracle;

#[cfg(target_arch = "wasm32")]
impl crate::oracle::LedgerReader for WasmOracle {
    fn read_oracle_price(
        &self,
        oracle_account: &[u8; 20],
        document_id: u32,
        asset_ticker: &[u8; 20],
    ) -> Option<crate::oracle::RawOracleData> {
        let mut price: u64 = 0;
        let mut scale: i8 = 0;
        let mut time: u64 = 0;
        let r = unsafe {
            read_oracle_price_entry(
                oracle_account.as_ptr(),
                document_id,
                asset_ticker.as_ptr(),
                &mut price as *mut u64,
                &mut scale as *mut i8,
                &mut time as *mut u64,
            )
        };
        if r != 0 {
            return None;
        }
        Some(crate::oracle::RawOracleData {
            asset_price: price,
            scale,
            last_update_time: time,
        })
    }
}

// ── Accept / Rollback wrappers ────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
pub(crate) fn accept_tx() -> ! {
    unsafe { accept(core::ptr::null(), 0, 0) }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn rollback_tx(err: LendingError) -> ! {
    let code = err.to_exit_code() as i64;
    unsafe { rollback(core::ptr::null(), 0, code) }
}
