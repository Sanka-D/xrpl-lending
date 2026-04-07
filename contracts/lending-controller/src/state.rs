/// On-chain state structures and storage layout.
///
/// Because xrpl-wasm-std uses no_std + no_alloc, all structures are fixed-size.
/// No HashMap or Vec — state is stored on-chain as key-value pairs.
///
/// Storage key scheme (ASCII, max 48 bytes):
///
///   "mkt:{i}:cfg:{field}"        MarketConfig fields  (i = u8 asset index, 0-padded)
///   "mkt:{i}:int:{field}"        InterestState fields
///   "mkt:{i}:ora:{field}"        OracleConfig fields
///   "pos:{addr20hex}:{i}:{f}"    UserPosition fields  (addr = 20-byte hex, 40 chars)
///   "glb:{field}"                Global state
///
/// V1 asset indices:
///   0 = XRP
///   1 = RLUSD
///   2 = wBTC

use crate::math::{WAD, BPS};

// ── Constants ────────────────────────────────────────────────────────────────

/// Maximum number of markets (assets) supported.
pub const MAX_MARKETS: u8 = 8;

/// V1 asset indices
pub const ASSET_XRP: u8 = 0;
pub const ASSET_RLUSD: u8 = 1;
pub const ASSET_WBTC: u8 = 2;
pub const NUM_V1_MARKETS: u8 = 3;

/// Native decimal places per V1 asset.
///   XRP:   6  (1 XRP   = 1,000,000 drops)
///   RLUSD: 6  (1 RLUSD = 1,000,000 smallest units)
///   wBTC:  8  (1 BTC   = 100,000,000 satoshis)
pub const ASSET_DECIMALS: [u8; 3] = [6, 6, 8];

/// Oracle account for price reads.
/// Local Bedrock: rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh (genesis account, used as mock oracle)
/// AlphaNet/Production: change back to rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7
pub const DIA_ORACLE_ACCOUNT: [u8; 20] = [
    0xb5, 0xf7, 0x62, 0x79, 0x8a, 0x53, 0xd5, 0x43, 0xa0, 0x14,
    0xca, 0xf8, 0xb2, 0x97, 0xcf, 0xf8, 0xf2, 0xf9, 0x37, 0xe8,
];
pub const DIA_DOCUMENT_ID: u32 = 42;
pub const MAX_ORACLE_STALENESS_SECS: u64 = 86400; // 24h — permissif pour tests locaux

/// BTC asset ticker in DIA (hex-encoded): "BTC\0\0..." padded to 20 bytes
pub const TICKER_BTC_HEX: [u8; 20] = [
    0x42, 0x54, 0x43, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];
pub const TICKER_XRP_HEX: [u8; 20] = [
    0x58, 0x52, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];
pub const TICKER_RLUSD_HEX: [u8; 20] = [
    0x52, 0x4c, 0x55, 0x53, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/// RLUSD price circuit breaker: pause if DIA price outside [0.95, 1.05] USD
pub const RLUSD_CB_LOW_BPS: u64 = 9500;   // 0.95 = 9500 bps
pub const RLUSD_CB_HIGH_BPS: u64 = 10500; // 1.05 = 10500 bps
/// Hardcoded RLUSD price when inside circuit-breaker bounds (WAD-scaled)
pub const RLUSD_FIXED_PRICE: u128 = WAD;   // 1.00 USD

// ── MarketConfig ─────────────────────────────────────────────────────────────

/// Static risk parameters for one market. Set by admin, rarely changed.
/// All percentages in basis points (10_000 = 100%).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketConfig {
    /// Max LTV: max debt / collateral value. Borrow capacity = collateral × ltv.
    pub ltv: u64,
    /// Liquidation threshold: HF = collateral × liq_threshold / debt.
    pub liquidation_threshold: u64,
    /// Bonus paid to liquidator on seized collateral (on top of 100%).
    pub liquidation_bonus: u64,
    /// Fraction of interest that goes to the protocol reserve.
    pub reserve_factor: u64,
    /// Max liquidation per call: 50% of debt.
    pub max_liquidation_bps: u64,
    /// Optimal utilization for kinked interest rate curve.
    pub optimal_utilization: u64,
    /// Base rate (intercept), in BPS annual.
    pub base_rate: u64,
    /// Slope below optimal utilization, in BPS annual.
    pub slope1: u64,
    /// Slope above optimal utilization, in BPS annual.
    pub slope2: u64,
    /// Whether borrowing is enabled for this market.
    pub borrow_enabled: bool,
    /// Whether the asset can be used as collateral.
    pub collateral_enabled: bool,
    /// Asset index (0=XRP, 1=RLUSD, 2=wBTC).
    pub asset_index: u8,
}

impl MarketConfig {
    /// Validate that risk params are internally consistent.
    pub fn is_valid(&self) -> bool {
        self.ltv <= self.liquidation_threshold
            && self.liquidation_threshold <= BPS as u64
            && self.liquidation_bonus > 0
            && self.optimal_utilization < BPS as u64
            && self.max_liquidation_bps <= BPS as u64
    }
}

/// Default MarketConfig for XRP
pub const XRP_MARKET: MarketConfig = MarketConfig {
    ltv: 7500,                  // 75%
    liquidation_threshold: 8000,// 80%
    liquidation_bonus: 500,     // 5%
    reserve_factor: 2000,       // 20%
    max_liquidation_bps: 5000,  // 50%
    optimal_utilization: 8000,  // 80%
    base_rate: 0,
    slope1: 400,                // 4%
    slope2: 30000,              // 300%
    borrow_enabled: true,
    collateral_enabled: true,
    asset_index: ASSET_XRP,
};

/// Default MarketConfig for RLUSD
pub const RLUSD_MARKET: MarketConfig = MarketConfig {
    ltv: 8000,                  // 80%
    liquidation_threshold: 8500,// 85%
    liquidation_bonus: 400,     // 4%
    reserve_factor: 1000,       // 10%
    max_liquidation_bps: 5000,  // 50%
    optimal_utilization: 9000,  // 90%
    base_rate: 0,
    slope1: 400,                // 4%
    slope2: 6000,               // 60%
    borrow_enabled: true,
    collateral_enabled: true,
    asset_index: ASSET_RLUSD,
};

/// Default MarketConfig for wBTC
pub const WBTC_MARKET: MarketConfig = MarketConfig {
    ltv: 7300,                  // 73%
    liquidation_threshold: 7800,// 78%
    liquidation_bonus: 650,     // 6.5%
    reserve_factor: 2000,       // 20%
    max_liquidation_bps: 5000,  // 50%
    optimal_utilization: 4500,  // 45%
    base_rate: 0,
    slope1: 700,                // 7%
    slope2: 30000,              // 300%
    borrow_enabled: true,
    collateral_enabled: true,
    asset_index: ASSET_WBTC,
};

/// All V1 market configs in index order
pub const V1_MARKETS: [MarketConfig; 3] = [XRP_MARKET, RLUSD_MARKET, WBTC_MARKET];

// ── InterestState ─────────────────────────────────────────────────────────────

/// Dynamic interest state for one market. Updated on every interaction.
/// Indices are WAD-scaled (start at WAD = 1.0). Using WAD avoids u128 overflow
/// that would occur with RAY-scaled indices (see math.rs overflow constraints).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InterestState {
    /// Current annual borrow rate in BPS (computed from utilization).
    pub borrow_rate_bps: u64,
    /// Current annual supply rate in BPS.
    pub supply_rate_bps: u64,
    /// Cumulative borrow index (WAD-scaled). Starts at WAD (1.0).
    /// actualDebt = storedDebt × borrowIndex / userBorrowIndexAtEntry
    pub borrow_index: u128,
    /// Cumulative supply index (WAD-scaled). Starts at WAD (1.0).
    pub supply_index: u128,
    /// UNIX timestamp (seconds) of last index update.
    pub last_update_timestamp: u64,
    /// Total outstanding borrows (in native asset units × WAD).
    pub total_borrows: u128,
    /// Total assets in the supply vault (in native asset units × WAD).
    pub total_supply: u128,
}

impl InterestState {
    /// Fresh state for a newly configured market.
    pub const fn new() -> Self {
        InterestState {
            borrow_rate_bps: 0,
            supply_rate_bps: 0,
            borrow_index: WAD,  // 1.0
            supply_index: WAD,  // 1.0
            last_update_timestamp: 0,
            total_borrows: 0,
            total_supply: 0,
        }
    }

    /// Utilization = total_borrows / (total_supply + total_borrows) in BPS.
    /// Returns 0 if no supply.
    pub fn utilization_bps(&self) -> u64 {
        let denominator = self.total_supply + self.total_borrows;
        if denominator == 0 {
            return 0;
        }
        ((self.total_borrows * BPS) / denominator) as u64
    }
}

// ── OracleConfig ─────────────────────────────────────────────────────────────

/// Oracle configuration for one market.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OracleConfig {
    /// DIA oracle account (20-byte XRPL AccountID).
    pub dia_account: [u8; 20],
    /// Oracle document ID on-chain (XLS-47).
    pub oracle_document_id: u32,
    /// Max acceptable age of price data in seconds.
    pub max_staleness: u64,
    /// Asset ticker in DIA format (hex-padded to 20 bytes).
    pub asset_ticker_hex: [u8; 20],
    /// If true, price is hardcoded (RLUSD circuit-breaker behavior).
    pub use_fixed_price: bool,
    /// Fixed price in WAD (only used when use_fixed_price = true).
    pub fixed_price: u128,
}

pub const XRP_ORACLE: OracleConfig = OracleConfig {
    dia_account: DIA_ORACLE_ACCOUNT,
    oracle_document_id: DIA_DOCUMENT_ID,
    max_staleness: MAX_ORACLE_STALENESS_SECS,
    asset_ticker_hex: TICKER_XRP_HEX,
    use_fixed_price: false,
    fixed_price: 0,
};

pub const RLUSD_ORACLE: OracleConfig = OracleConfig {
    dia_account: DIA_ORACLE_ACCOUNT,
    oracle_document_id: DIA_DOCUMENT_ID,
    max_staleness: MAX_ORACLE_STALENESS_SECS,
    asset_ticker_hex: TICKER_RLUSD_HEX,
    use_fixed_price: false,  // price is read but circuit-breaker applied in oracle.rs
    fixed_price: RLUSD_FIXED_PRICE,
};

pub const WBTC_ORACLE: OracleConfig = OracleConfig {
    dia_account: DIA_ORACLE_ACCOUNT,
    oracle_document_id: DIA_DOCUMENT_ID,
    max_staleness: MAX_ORACLE_STALENESS_SECS,
    asset_ticker_hex: TICKER_BTC_HEX,
    use_fixed_price: false,
    fixed_price: 0,
};

pub const V1_ORACLES: [OracleConfig; 3] = [XRP_ORACLE, RLUSD_ORACLE, WBTC_ORACLE];

// ── UserPosition ─────────────────────────────────────────────────────────────

/// In-memory snapshot of one user's position across all markets.
/// Used for health factor computations — not persisted as a single struct.
/// On-chain, each field is stored individually with composite keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserPositionForAsset {
    /// Collateral deposited, in native asset units (not WAD-scaled).
    pub collateral: u128,
    /// Stored debt principal at the time of borrow (not WAD-scaled).
    pub debt: u128,
    /// Borrow index at the time the user last borrowed/repaid.
    /// Used to compute actual_debt = debt × current_index / user_index.
    pub user_borrow_index: u128,
}

impl UserPositionForAsset {
    pub const fn empty() -> Self {
        UserPositionForAsset {
            collateral: 0,
            debt: 0,
            user_borrow_index: WAD,
        }
    }

    pub fn has_collateral(&self) -> bool { self.collateral > 0 }
    pub fn has_debt(&self) -> bool { self.debt > 0 }
}

/// Full position across all V1 markets (stack-allocated, fixed size).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserPosition {
    pub markets: [UserPositionForAsset; MAX_MARKETS as usize],
    pub num_markets: u8,
}

impl UserPosition {
    pub const fn empty() -> Self {
        UserPosition {
            markets: [UserPositionForAsset {
                collateral: 0,
                debt: 0,
                user_borrow_index: WAD,
            }; MAX_MARKETS as usize],
            num_markets: 0,
        }
    }
}

// ── Storage key helpers ───────────────────────────────────────────────────────
// These construct fixed-size byte arrays used as storage keys.
// No heap allocation — uses stack buffers.

/// Build key: "mkt:{i}:cfg:{field}" — max 20 bytes
/// field must be ≤ 12 bytes.
pub fn market_config_key(asset_index: u8, field: &[u8]) -> ([u8; 24], usize) {
    let mut buf = [0u8; 24];
    buf[0] = b'm'; buf[1] = b'k'; buf[2] = b't'; buf[3] = b':';
    buf[4] = b'0' + asset_index;
    buf[5] = b':'; buf[6] = b'c'; buf[7] = b'f'; buf[8] = b'g'; buf[9] = b':';
    let field_len = field.len().min(14);
    buf[10..10 + field_len].copy_from_slice(&field[..field_len]);
    (buf, 10 + field_len)
}

/// Build key: "mkt:{i}:int:{field}" — max 24 bytes
pub fn market_interest_key(asset_index: u8, field: &[u8]) -> ([u8; 24], usize) {
    let mut buf = [0u8; 24];
    buf[0] = b'm'; buf[1] = b'k'; buf[2] = b't'; buf[3] = b':';
    buf[4] = b'0' + asset_index;
    buf[5] = b':'; buf[6] = b'i'; buf[7] = b'n'; buf[8] = b't'; buf[9] = b':';
    let field_len = field.len().min(14);
    buf[10..10 + field_len].copy_from_slice(&field[..field_len]);
    (buf, 10 + field_len)
}

/// Build key: "pos:{account_40_hex}:{i}:{field}"
/// account is hex-encoded (40 ASCII chars) to avoid binary bytes in field names.
/// Bedrock may require printable-ASCII field names for `set/get_data_object_field`.
/// Buffer size 56: 4 "pos:" + 40 hex + 1 ":" + 1 digit + 1 ":" + 4 field = 51 max → 56
pub fn user_position_key(account: &[u8; 20], asset_index: u8, field: &[u8]) -> ([u8; 56], usize) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut buf = [0u8; 56];
    buf[0] = b'p'; buf[1] = b'o'; buf[2] = b's'; buf[3] = b':';
    // Hex-encode 20 account bytes → 40 ASCII hex chars
    for i in 0..20 {
        buf[4 + i * 2]     = HEX[(account[i] >> 4) as usize];
        buf[4 + i * 2 + 1] = HEX[(account[i] & 0xf) as usize];
    }
    buf[44] = b':';
    buf[45] = b'0' + asset_index;
    buf[46] = b':';
    let field_len = field.len().min(8);
    buf[47..47 + field_len].copy_from_slice(&field[..field_len]);
    (buf, 47 + field_len)
}

/// Build key: "glb:{field}"
pub fn global_key(field: &[u8]) -> ([u8; 16], usize) {
    let mut buf = [0u8; 16];
    buf[0] = b'g'; buf[1] = b'l'; buf[2] = b'b'; buf[3] = b':';
    let field_len = field.len().min(12);
    buf[4..4 + field_len].copy_from_slice(&field[..field_len]);
    (buf, 4 + field_len)
}

// ── u128 serialization ────────────────────────────────────────────────────────
// On-chain storage uses byte arrays. We serialize u128 as 16 bytes little-endian.

pub fn u128_to_bytes(v: u128) -> [u8; 16] {
    v.to_le_bytes()
}

pub fn bytes_to_u128(b: &[u8; 16]) -> u128 {
    u128::from_le_bytes(*b)
}

pub fn u64_to_bytes(v: u64) -> [u8; 8] {
    v.to_le_bytes()
}

pub fn bytes_to_u64(b: &[u8; 8]) -> u64 {
    u64::from_le_bytes(*b)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_configs_are_valid() {
        assert!(XRP_MARKET.is_valid(), "XRP market config invalid");
        assert!(RLUSD_MARKET.is_valid(), "RLUSD market config invalid");
        assert!(WBTC_MARKET.is_valid(), "wBTC market config invalid");
    }

    #[test]
    fn ltv_below_liquidation_threshold() {
        assert!(XRP_MARKET.ltv < XRP_MARKET.liquidation_threshold);
        assert!(RLUSD_MARKET.ltv < RLUSD_MARKET.liquidation_threshold);
        assert!(WBTC_MARKET.ltv < WBTC_MARKET.liquidation_threshold);
    }

    #[test]
    fn market_indices_correct() {
        assert_eq!(V1_MARKETS[ASSET_XRP as usize].asset_index, ASSET_XRP);
        assert_eq!(V1_MARKETS[ASSET_RLUSD as usize].asset_index, ASSET_RLUSD);
        assert_eq!(V1_MARKETS[ASSET_WBTC as usize].asset_index, ASSET_WBTC);
    }

    #[test]
    fn interest_state_starts_at_one() {
        let s = InterestState::new();
        assert_eq!(s.borrow_index, WAD);
        assert_eq!(s.supply_index, WAD);
        assert_eq!(s.total_borrows, 0);
        assert_eq!(s.total_supply, 0);
    }

    #[test]
    fn utilization_zero_when_no_supply() {
        let s = InterestState::new();
        assert_eq!(s.utilization_bps(), 0);
    }

    #[test]
    fn utilization_80pct() {
        let mut s = InterestState::new();
        s.total_supply = 20 * WAD;
        s.total_borrows = 80 * WAD;
        assert_eq!(s.utilization_bps(), 8000); // 80%
    }

    #[test]
    fn utilization_100pct() {
        let mut s = InterestState::new();
        s.total_supply = 0;
        s.total_borrows = 100 * WAD;
        assert_eq!(s.utilization_bps(), 10000); // 100%
    }

    #[test]
    fn user_position_empty() {
        let pos = UserPositionForAsset::empty();
        assert!(!pos.has_collateral());
        assert!(!pos.has_debt());
        assert_eq!(pos.user_borrow_index, WAD);
    }

    #[test]
    fn storage_key_market_config() {
        let (key, len) = market_config_key(0, b"ltv");
        assert_eq!(&key[..len], b"mkt:0:cfg:ltv");

        let (key2, len2) = market_config_key(2, b"borrow_enab");
        assert_eq!(&key2[..len2], b"mkt:2:cfg:borrow_enab");
    }

    #[test]
    fn storage_key_market_interest() {
        let (key, len) = market_interest_key(1, b"bidx");
        assert_eq!(&key[..len], b"mkt:1:int:bidx");
    }

    #[test]
    fn storage_key_user_position() {
        let account = [0xAAu8; 20];
        let (key, len) = user_position_key(&account, 0, b"col");
        // "pos:" (4) + 40 hex (40) + ":" (1) + "0" (1) + ":" (1) + "col" (3) = 50
        assert_eq!(len, 50);
        assert_eq!(&key[..4], b"pos:");
        // 0xAA hex-encoded = "aa"
        assert_eq!(&key[4..6], b"aa");
        assert_eq!(key[44], b':');
        assert_eq!(key[45], b'0'); // asset_index 0
        assert_eq!(&key[47..50], b"col");
    }

    #[test]
    fn storage_key_different_assets_differ() {
        let account = [0x11u8; 20];
        let (k0, l0) = user_position_key(&account, 0, b"col");
        let (k1, l1) = user_position_key(&account, 1, b"col");
        assert_ne!(&k0[..l0], &k1[..l1]);
    }

    #[test]
    fn storage_key_global() {
        let (key, len) = global_key(b"paused");
        assert_eq!(&key[..len], b"glb:paused");
    }

    #[test]
    fn u128_serialization_roundtrip() {
        let vals: [u128; 5] = [0, 1, WAD, u128::MAX, 123_456_789_012_345_678];
        for v in vals {
            let bytes = u128_to_bytes(v);
            assert_eq!(bytes_to_u128(&bytes), v);
        }
    }

    #[test]
    fn u64_serialization_roundtrip() {
        let vals: [u64; 4] = [0, 1, 8000, u64::MAX];
        for v in vals {
            let bytes = u64_to_bytes(v);
            assert_eq!(bytes_to_u64(&bytes), v);
        }
    }

    #[test]
    fn rlusd_circuit_breaker_bounds() {
        // 0.95 WAD in bps = 9500
        let low = (RLUSD_CB_LOW_BPS as u128 * WAD) / 10000;
        let high = (RLUSD_CB_HIGH_BPS as u128 * WAD) / 10000;
        assert!(low < RLUSD_FIXED_PRICE);
        assert!(high > RLUSD_FIXED_PRICE);
    }

    #[test]
    fn xrp_risk_params_match_spec() {
        assert_eq!(XRP_MARKET.ltv, 7500);
        assert_eq!(XRP_MARKET.liquidation_threshold, 8000);
        assert_eq!(XRP_MARKET.liquidation_bonus, 500);
        assert_eq!(XRP_MARKET.reserve_factor, 2000);
        assert_eq!(XRP_MARKET.optimal_utilization, 8000);
        assert_eq!(XRP_MARKET.slope1, 400);
        assert_eq!(XRP_MARKET.slope2, 30000);
    }

    #[test]
    fn rlusd_risk_params_match_spec() {
        assert_eq!(RLUSD_MARKET.ltv, 8000);
        assert_eq!(RLUSD_MARKET.liquidation_threshold, 8500);
        assert_eq!(RLUSD_MARKET.liquidation_bonus, 400);
        assert_eq!(RLUSD_MARKET.reserve_factor, 1000);
        assert_eq!(RLUSD_MARKET.optimal_utilization, 9000);
        assert_eq!(RLUSD_MARKET.slope1, 400);
        assert_eq!(RLUSD_MARKET.slope2, 6000);
    }

    #[test]
    fn wbtc_risk_params_match_spec() {
        assert_eq!(WBTC_MARKET.ltv, 7300);
        assert_eq!(WBTC_MARKET.liquidation_threshold, 7800);
        assert_eq!(WBTC_MARKET.liquidation_bonus, 650);
        assert_eq!(WBTC_MARKET.reserve_factor, 2000);
        assert_eq!(WBTC_MARKET.optimal_utilization, 4500);
        assert_eq!(WBTC_MARKET.slope1, 700);
        assert_eq!(WBTC_MARKET.slope2, 30000);
    }
}
