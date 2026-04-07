/// XRPL host context — abstracts ledger write operations.
///
/// Production (WASM): methods call Bedrock host_lib functions.
/// Tests (native): backed by `MockHost` with in-memory state.
///
/// Bedrock execution model:
///   - Exported functions return i32 (0 = success)
///   - WASM trap = tecFAILED_PROCESSING (state rolled back)
///   - No finish/proc_exit — just return from the function

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

// ── Bedrock host_lib imports ─────────────────────────────────────────────────
// All contract-useful functions are in the "host_lib" module.
// "env" only provides memory primitives (memory, store, load, size, allocate, deallocate).
// finish/proc_exit are in the validation whitelist but NOT registered as host functions.

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "host_lib")]
extern "C" {
    /// Ledger close time (Ripple epoch seconds). Returns i32 NOT i64.
    fn get_parent_ledger_time() -> i32;

    /// Read a transaction field into `out_ptr`.
    /// field_code = (type_id << 16) | field_nth.
    /// Returns bytes written, or negative on error.
    fn get_tx_field(field_code: i32, out_ptr: *mut u8, out_len: i32) -> i32;

    /// Read a field from the CURRENT CONTRACT's ledger object (Contract entry).
    /// field = (type_code << 16) | nth
    /// Returns bytes written, or negative on error.
    fn get_current_ledger_obj_field(
        field: i32,
        out_buff_ptr: *mut u8,
        out_buff_len: i32,
    ) -> i32;


    /// Write the contract's full state blob atomically.
    /// Replaces the entire contract state with the provided byte buffer.
    /// Source: ripple/xrpl-wasm-stdlib — the CORRECT state write mechanism.
    fn update_data(data_ptr: *const u8, data_len: i32) -> i32;

    /// Write a named field to the data object of `account` (key-value store).
    fn set_data_object_field(
        account_ptr: *const u8,
        field_name_ptr: *const u8,
        field_name_len: i32,
        value_ptr: *const u8,
        value_len: i32,
        type_id: i32,
    ) -> i32;

    /// Read a named field from the data object of `account`.
    /// This is the key-value store. update_data likely writes under a fixed field name
    /// using the contract's own account.
    /// Returns bytes written, or negative on error.
    fn get_data_object_field(
        account_ptr: *const u8,
        field_name_ptr: *const u8,
        field_name_len: i32,
        out_ptr: *mut u8,
        out_len: i32,
        type_id: i32,
    ) -> i32;

    /// Read a function call parameter by index and type.
    /// Writes result to out_ptr, returns bytes written or negative on error.
    fn function_param(index: i32, type_id: i32, out_ptr: *mut u8, out_len: i32) -> i32;

    // ── Transaction building ──
    fn build_txn(tx_type: i32) -> i32;
    fn add_txn_field(field_code: i32, value_ptr: *const u8, value_len: i32, type_id: i32) -> i32;
    fn emit_built_txn() -> i32;

    // ── Tracing / debugging ──
    // XRPL Hooks-style: trace(tag_ptr, tag_len, value_ptr, value_len, datatype)
    // datatype: 0 = raw bytes, 1 = integer, 2 = hex, 3 = string, etc.
    fn trace(tag_ptr: *const u8, tag_len: i32, value_ptr: *const u8, value_len: i32, datatype: i32) -> i32;

    /// Trace a numeric value: trace_num(tag_ptr, tag_len, number) → i32
    fn trace_num(tag_ptr: *const u8, tag_len: i32, number: i64) -> i32;
}

// ── Parameter reading helpers ─────────────────────────────────────────────────
// Bedrock: exported functions take NO parameters. Use function_param(index, type_id) instead.

#[cfg(target_arch = "wasm32")]
pub(crate) fn read_param_u32(index: i32) -> u32 {
    let mut buf = [0u8; 4];
    let r = unsafe { function_param(index, 2 /* STI_UINT32 */, buf.as_mut_ptr(), 4) };
    if r < 0 { 0 } else { u32::from_be_bytes(buf) }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn read_param_u64(index: i32) -> u64 {
    let mut buf = [0u8; 8];
    let r = unsafe { function_param(index, 3 /* STI_UINT64 */, buf.as_mut_ptr(), 8) };
    if r < 0 { 0 } else { u64::from_be_bytes(buf) }
}

// ── SField codes ─────────────────────────────────────────────────────────────

/// sfAccount — transaction sender (AccountID type=8, nth=1)
const SF_ACCOUNT: i32 = (8 << 16) | 1;

// ── Accept / Rollback ────────────────────────────────────────────────────────
// Bedrock model: return from function = tesSUCCESS, trap = tecFAILED_PROCESSING.

/// Accept the transaction. Returns 0 to the host runtime.
#[cfg(target_arch = "wasm32")]
pub(crate) fn accept_tx() -> i32 {
    0
}

/// Rollback the transaction by trapping (WASM unreachable).
/// This causes tecFAILED_PROCESSING on the ledger.
#[cfg(target_arch = "wasm32")]
pub(crate) fn rollback_tx(_err: LendingError) -> ! {
    core::arch::wasm32::unreachable()
}

/// Expose a return value for read-only queries.
/// In Bedrock, we use trace() as a placeholder — proper return mechanism TBD.
#[cfg(target_arch = "wasm32")]
pub(crate) fn set_return_value(_ptr: *const u8, _len: u32) {
    // TODO: Bedrock may have a specific mechanism for return values.
    // For now this is a no-op; queries can read state directly.
}

// ── WASM helper wrappers ─────────────────────────────────────────────────────

/// Read a 20-byte AccountID from a tx field, handling potential VL-encoding.
/// If get_tx_field returns the VL-encoded form (0x14 prefix + 20 bytes = 21 bytes total),
/// we request 21 bytes and strip the first byte if it's 0x14 (length prefix for 20 bytes).
#[cfg(target_arch = "wasm32")]
fn read_account_field(field_code: i32) -> Option<[u8; 20]> {
    // Request 21 bytes in case the field is VL-encoded (1-byte length prefix + 20 bytes)
    let mut buf = [0u8; 21];
    let r = unsafe { get_tx_field(field_code, buf.as_mut_ptr(), 21) };
    if r < 0 { return None; }
    let mut out = [0u8; 20];
    if r == 21 || (r == 20 && buf[0] == 0x14) {
        // VL-encoded: buf[0] = 0x14 (length=20), buf[1..21] = account bytes
        out.copy_from_slice(&buf[1..21]);
    } else if r >= 20 {
        // Non-VL-encoded: buf[0..20] = account bytes
        out.copy_from_slice(&buf[0..20]);
    } else {
        return None;
    }
    Some(out)
}

/// Get the caller's 20-byte AccountID (sfAccount = TX sender).
#[cfg(target_arch = "wasm32")]
pub(crate) fn get_caller() -> [u8; 20] {
    match read_account_field(SF_ACCOUNT) {
        Some(acc) => acc,
        None => core::arch::wasm32::unreachable(),
    }
}


/// Expose get_tx_field for direct use in probes.
#[cfg(target_arch = "wasm32")]
pub(crate) unsafe fn get_tx_field_raw(field_code: i32, out_ptr: *mut u8, out_len: i32) -> i32 {
    get_tx_field(field_code, out_ptr, out_len)
}

/// Expose set_data_object_field for probe testing.
#[cfg(target_arch = "wasm32")]
pub(crate) unsafe fn set_data_object_field_raw(
    account_ptr: *const u8,
    field_name_ptr: *const u8,
    field_name_len: i32,
    value_ptr: *const u8,
    value_len: i32,
    type_id: i32,
) -> i32 {
    set_data_object_field(account_ptr, field_name_ptr, field_name_len, value_ptr, value_len, type_id)
}

/// Expose get_data_object_field for probe testing.
#[cfg(target_arch = "wasm32")]
pub(crate) unsafe fn get_data_object_field_raw(
    account_ptr: *const u8,
    field_name_ptr: *const u8,
    field_name_len: i32,
    out_ptr: *mut u8,
    out_len: i32,
    type_id: i32,
) -> i32 {
    get_data_object_field(account_ptr, field_name_ptr, field_name_len, out_ptr, out_len, type_id)
}

/// Read from the contract's current ledger object using a specific field code.
/// Returns bytes read, 0 if field not found.
#[cfg(target_arch = "wasm32")]
pub(crate) fn read_ledger_field(field: i32, val: &mut [u8]) -> usize {
    let r = unsafe { get_current_ledger_obj_field(field, val.as_mut_ptr(), val.len() as i32) };
    if r < 0 { 0 } else { r as usize }
}


/// Write the contract's full state blob via update_data.
/// Returns true if the write was accepted.
#[cfg(target_arch = "wasm32")]
pub(crate) fn write_blob(data: &[u8]) -> bool {
    let r = unsafe { update_data(data.as_ptr(), data.len() as i32) };
    r >= 0
}

/// Stub: read_state is a no-op until we implement the blob state model.
/// Returns 0 bytes (all loads return default values = zero-initialized state).
#[cfg(target_arch = "wasm32")]
pub(crate) fn read_state(_key: &[u8], _val: &mut [u8]) -> usize {
    0
}

/// Stub: write_state is a no-op until we implement the blob state model.
#[cfg(target_arch = "wasm32")]
pub(crate) fn write_state(_key: &[u8], _val: &[u8]) {
    // No-op: state will be written via write_blob() at function end
}

/// Probe helper: write_state_typed used in probe functions.
#[cfg(target_arch = "wasm32")]
pub(crate) fn write_state_typed(key: &[u8], val: &[u8], _type_id: i32) {
    write_state(key, val);
}

/// Probe helper: read_state_typed used in probe functions.
#[cfg(target_arch = "wasm32")]
pub(crate) fn read_state_typed(key: &[u8], val: &mut [u8], _type_id: i32) -> usize {
    read_state(key, val)
}

/// Write a diagnostic message to the WasmTrace log.
#[cfg(target_arch = "wasm32")]
pub(crate) fn trace_raw(msg: &[u8]) {
    let empty = [0u8; 0];
    let _ = unsafe { trace(msg.as_ptr(), msg.len() as i32, empty.as_ptr(), 0, 0) };
}

/// Trace a numeric value to WasmTrace log.
/// Output: WasmTrace[<id>]: <tag> = <number>
#[cfg(target_arch = "wasm32")]
pub(crate) fn trace_num_raw(tag: &[u8], val: i64) {
    let _ = unsafe { trace_num(tag.as_ptr(), tag.len() as i32, val) };
}

// ── WasmHost : HostContext ────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
pub(crate) struct WasmHost;

#[cfg(target_arch = "wasm32")]
impl HostContext for WasmHost {
    fn current_time(&self) -> u64 {
        let t = unsafe { get_parent_ledger_time() };
        if t < 0 { 0 } else { t as u64 }
    }

    fn vault_deposit(
        &mut self,
        _vault: &[u8; 20],
        _asset_index: u8,
        _amount: u128,
    ) -> LendingResult<()> {
        // Stubbed: build_txn/add_txn_field/emit_built_txn signatures not yet verified.
        // State-only testing: pretend the token transfer succeeded.
        Ok(())
    }

    fn vault_withdraw(
        &mut self,
        _vault: &[u8; 20],
        _asset_index: u8,
        _amount: u128,
    ) -> LendingResult<()> {
        // Stubbed: see vault_deposit above.
        Ok(())
    }

    fn transfer_to(
        &mut self,
        _recipient: &[u8; 20],
        _asset_index: u8,
        _amount: u128,
    ) -> LendingResult<()> {
        // Stubbed: see vault_deposit above.
        Ok(())
    }
}

// ── WasmOracle : LedgerReader ────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
pub(crate) struct WasmOracle;

#[cfg(target_arch = "wasm32")]
impl crate::oracle::LedgerReader for WasmOracle {
    fn read_oracle_price(
        &self,
        _oracle_account: &[u8; 20],
        _document_id: u32,
        asset_ticker: &[u8; 20],
    ) -> Option<crate::oracle::RawOracleData> {
        // Hardcoded prices for local Bedrock testing.
        // TODO: Implement using oracle_keylet + cache_ledger_obj + get_ledger_obj_field
        //       once those host function signatures are verified on the runtime.
        use crate::state::{TICKER_XRP_HEX, TICKER_RLUSD_HEX, TICKER_BTC_HEX};
        let (asset_price, scale) = if asset_ticker == &TICKER_XRP_HEX {
            (215_000_000u64, -8i8)            // XRP = $2.15
        } else if asset_ticker == &TICKER_RLUSD_HEX {
            (100_000_000u64, -8i8)            // RLUSD = $1.00
        } else if asset_ticker == &TICKER_BTC_HEX {
            (8_400_000_000_000u64, -8i8)      // BTC = $84,000
        } else {
            return None;
        };
        Some(crate::oracle::RawOracleData {
            asset_price,
            scale,
            // Far-future timestamp: never stale
            last_update_time: u64::MAX / 2,
        })
    }
}
