/// Protocol error codes.
///
/// Each variant maps to a unique u32 for on-chain debugging.
/// Returned as the negative of the code (e.g. -101) in contract exit values.
///
/// Range allocation:
///   1xx  General / validation
///   2xx  Supply vault operations
///   3xx  Collateral
///   4xx  Borrow / repay
///   5xx  Liquidation
///   6xx  Oracle / price
///   7xx  Interest accrual
///   8xx  Market configuration
///   9xx  Admin / access control

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum LendingError {
    // 1xx — General
    MathOverflow = 100,
    InvalidAmount = 101,    // zero or dust amount
    InvalidAsset = 102,     // unknown asset index
    MarketPaused = 103,     // market is paused
    Unauthorized = 104,     // caller not allowed
    ContractPaused = 105,   // entire protocol is paused

    // 2xx — Supply vault
    InsufficientLiquidity = 200,    // vault has less than requested
    VaultNotFound = 201,
    WithdrawExceedsBalance = 202,   // user withdrawing more shares than held
    SupplyNotEnabled = 203,

    // 3xx — Collateral
    CollateralNotEnabled = 300,     // asset not accepted as collateral
    InsufficientCollateral = 301,   // user collateral < requested withdraw
    WithdrawWouldLiquidate = 302,   // withdraw would push HF < 1.0
    CollateralAlreadyDeposited = 303,

    // 4xx — Borrow / repay
    BorrowNotEnabled = 400,
    BorrowCapacityExceeded = 401,   // borrow > LTV-adjusted collateral value
    InsufficientBorrowLiquidity = 402, // vault doesn't have requested amount
    RepayExceedsDebt = 403,         // repay amount > actual debt
    NoBorrowBalance = 404,          // user has no debt in this market
    HealthFactorTooLow = 405,       // borrow would push HF below minimum

    // 5xx — Liquidation
    PositionHealthy = 500,          // HF >= 1.0, not liquidatable
    MaxLiquidationExceeded = 501,   // amount > 50% of debt
    InvalidLiquidation = 502,       // same asset for debt and collateral
    InsufficientCollateralToSeize = 503, // borrower's collateral < bonus-adjusted seize amount
    LiquidatorInsufficientFunds = 504,

    // 6xx — Oracle / price
    OracleStale = 600,              // price older than max_staleness
    OraclePriceZero = 601,
    OracleNotConfigured = 602,
    OracleCircuitBreaker = 603,     // RLUSD price outside [0.95, 1.05]
    OracleAssetNotFound = 604,      // asset not in PriceDataSeries

    // 7xx — Interest
    InterestAccrualFailed = 700,
    InvalidInterestRate = 701,      // computed rate out of bounds

    // 8xx — Market configuration
    MarketNotConfigured = 800,
    MarketAlreadyExists = 801,
    InvalidRiskParams = 802,        // e.g. LTV > liquidation threshold
    TooManyMarkets = 803,           // exceeded MAX_MARKETS

    // 9xx — Admin
    NotAdmin = 900,
    AlreadyInitialized = 901,
}

impl LendingError {
    pub fn code(self) -> u32 {
        self as u32
    }

    /// Return as negative i32 for contract exit codes
    pub fn to_exit_code(self) -> i32 {
        -((self as u32) as i32)
    }
}

pub type LendingResult<T> = Result<T, LendingError>;
