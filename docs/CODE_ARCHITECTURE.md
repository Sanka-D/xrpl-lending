# XRPL Lending Protocol V1 — Architecture du code

## 1. Structure du monorepo

```
xrpl-lending/
├── contracts/lending-controller/   # Smart contract Rust → WASM
│   └── src/
│       ├── lib.rs          # Points d'entrée WASM (exports C)
│       ├── state.rs        # Layout de l'état on-chain + constantes V1
│       ├── math.rs         # Arithmétique WAD (fixed-point)
│       ├── interest.rs     # Modèle de taux + accrual des intérêts
│       ├── oracle.rs       # Lecture des prix DIA (XLS-47)
│       ├── health.rs       # Health factor + borrow capacity
│       ├── supply.rs       # Logique supply/withdraw
│       ├── collateral.rs   # Dépôt/retrait de collatéral
│       ├── borrow.rs       # Emprunt/remboursement
│       ├── liquidation.rs  # Liquidation
│       ├── errors.rs       # Codes d'erreur
│       └── host.rs         # Bindings ABI hôte XRPL-WASM
├── sdk/src/                        # SDK TypeScript
│   ├── client.ts           # LendingClient, encoding helpers, key builders
│   ├── types.ts            # Enums, interfaces, constantes, LendingError
│   ├── supply.ts           # supply(), withdraw(), getSupplyShares()
│   ├── borrow.ts           # borrow(), repay(), getDebtBalance()
│   ├── collateral.ts       # depositCollateral(), withdrawCollateral()
│   ├── liquidation.ts      # liquidate(), findLiquidatablePositions()
│   ├── oracle.ts           # getAllPrices(), rawToWad(), circuit breaker
│   ├── health.ts           # calculateHealthFactor(), calculateBorrowCapacity()
│   ├── positions.ts        # getUserPosition(), getAllInterestStates()
│   └── index.ts            # Barrel exports (API publique)
├── keeper/src/                     # Bot de liquidation TypeScript
│   ├── index.ts            # Point d'entrée, pipeline principal
│   ├── config.ts           # Configuration (env vars)
│   ├── oracle-watcher.ts   # Surveillance oracle + événements de prix
│   ├── monitor.ts          # Scan des positions (PositionMonitor)
│   ├── profitability.ts    # Calcul de rentabilité des liquidations
│   ├── liquidator.ts       # Exécution des liquidations
│   └── logger.ts           # Logging structuré
├── deploy/                         # Scripts de déploiement AlphaNet
│   ├── shared.ts           # Utilitaires partagés, loadDeployEnv()
│   ├── deploy-controller.ts # Build WASM + ContractCreate (XLS-101)
│   ├── deploy-vaults.ts    # Création des vaults (XLS-65)
│   ├── setup-markets.ts    # Setup complet (vaults + registration)
│   ├── register-vaults.ts  # Enregistrement vault accounts dans le contrat
│   ├── configure-markets.ts # Configuration paramètres marché + oracle
│   ├── setup-oracle.ts     # Vérification oracle DIA
│   └── deployed.json       # État de déploiement persisté
└── tests/                          # Tests E2E
    ├── helpers/
    │   └── simulated-ledger.ts  # Simulateur in-memory du contrat
    └── scenarios/
        └── full-lifecycle.ts    # 14 étapes de cycle de vie complet
```

---

## 2. Smart contract Rust

### 2.1 Contraintes de compilation

```rust
#![cfg_attr(target_arch = "wasm32", no_std)]
```

- **`no_std`** : pas de bibliothèque standard Rust. Pas de `Vec`, `HashMap`, `String`, ni allocation dynamique.
- Tous les buffers sont de taille fixe (tableaux `[u8; N]`).
- Compilé avec `cargo build --target wasm32-unknown-unknown --release`.

### 2.2 Points d'entrée WASM (`lib.rs`)

9 exports `#[no_mangle] extern "C"` :

| Export | Args WASM | Description |
|--------|-----------|-------------|
| `supply(asset_id: u32, amount: u64)` | index actif, unités natives | Mint des supply shares |
| `withdraw(asset_id: u32, shares: u64)` | index actif, parts | Burn des shares, retour des actifs |
| `deposit_collateral(asset_id: u32, amount: u64)` | — | Enregistre le collatéral |
| `withdraw_collateral(asset_id: u32, amount: u64)` | — | Libère collatéral (vérif HF) |
| `borrow(asset_id: u32, amount: u64)` | — | Vérifie LTV, envoie actifs au caller |
| `repay(asset_id: u32, amount: u64)` | — | Réduit la dette, rembourse trop-payé |
| `liquidate(borrower_ptr: u32, debt_id: u32, collat_id: u32, amount: u64)` | ptr 20-byte AccountID | Liquide une position |
| `get_health_factor(user_ptr: u32) -> u64` | ptr 20-byte AccountID | Retourne HF en WAD u64 |
| `get_user_position(user_ptr: u32) -> u32` | ptr 20-byte AccountID | Sérialise position → 144 bytes |

**Pattern commun de chaque write function :**
```rust
let result: LendingResult<()> = (|| {
    let caller = get_caller();          // Identifie le signataire
    let mut state = load_*(asset_index); // Charge l'état depuis le stockage
    handle_*(ctx, ...)?;                // Délègue à la logique métier
    store_*(...);                       // Persiste l'état muté
    Ok(())
})();
match result {
    Ok(()) => accept_tx(),
    Err(e) => rollback_tx(e),
}
```

### 2.3 Layout de l'état on-chain (`state.rs`)

Toutes les données sont stockées en paires clé-valeur d'octets bruts :

```
Intérêts de marché:   "mkt:{i}:int:{field}"     (ASCII + index u8 + 2-char field)
Position utilisateur: "pos:" + accountId[20B] + ":{i}:{field}"  (binaire mixte !)
Global (vaults):      "glb:{field}"
```

**Champs de marché** (`{field}`) : `br`, `sr`, `bi`, `si`, `ts`, `tb`, `tp`
**Champs de position** (`{field}`) : `co`, `de`, `bi`, `sh`

> **Point critique** : Les clés `pos:` contiennent 20 bytes binaires (AccountID brut), pas de l'ASCII. Cette convention est reproduite exactement dans le SDK TypeScript via `userPositionKey()`.

**Constantes V1 compilées** (`state.rs`) :

```rust
pub const NUM_V1_MARKETS: u8 = 3;
pub const ASSET_DECIMALS: [u8; 3] = [6, 6, 8];  // XRP=drops, RLUSD=6dec, wBTC=satoshis

pub static V1_MARKETS: [MarketConfig; 3] = [
    MarketConfig { ltv: 7500, liq_threshold: 8000, ... },  // XRP
    MarketConfig { ltv: 8000, liq_threshold: 8500, ... },  // RLUSD
    MarketConfig { ltv: 7300, liq_threshold: 7800, ... },  // wBTC
];
```

### 2.4 Arithmétique WAD (`math.rs`)

Tout le calcul financier utilise une représentation **fixed-point WAD** :

```
WAD = 1_000_000_000_000_000_000  (1e18)
BPS = 10_000                      (base points)
```

| Opération | Formule |
|-----------|---------|
| `wad_mul(a, b)` | `(a × b + 5e17) / 1e18` (arrondi half-up) |
| `wad_div(a, b)` | `(a × 1e18 + b/2) / b` (arrondi half-up) |
| BPS annuel → WAD/sec | `bps × WAD / (BPS × 31_536_000)` |
| Intérêt composé (Taylor 2 termes) | `WAD + rt + (rt)²/2` |

### 2.5 Modèle de taux (`interest.rs`)

**Utilisation** :
```
U = total_borrows × WAD / (total_borrows + total_supply)
```

**Borrow rate (kinked)** :
```
U ≤ U_opt : rate = base + (U/U_opt) × slope1
U > U_opt : rate = base + slope1 + ((U-U_opt)/(WAD-U_opt)) × slope2
```

**Supply rate** :
```
supply_rate = borrow_rate_per_sec × U × (1 − reserve_factor)
```

**Accrual des indexes** (appelé à chaque action utilisateur) :
```
borrow_compound = calculate_compound_interest(borrow_rate_per_sec_stored, elapsed)
new_borrow_index = wad_mul(old_borrow_index, borrow_compound)
new_total_borrows += interest_accrued
```

**Dette réelle depuis le principal stocké** :
```
actual_debt = stored_principal × current_borrow_index / user_borrow_index_at_entry
```

### 2.6 Oracle (`oracle.rs`)

Lit l'oracle DIA via le host ABI. Conversion prix brut → WAD :
```
price_wad = raw_AssetPrice × 10^(18 + Scale)
```
DIA utilise `Scale = -8`, donc `price_wad = raw_AssetPrice × 10^10`.

**Circuit breaker RLUSD** : prix ∈ [0.95 WAD, 1.05 WAD] → retourne `WAD`. Sinon → erreur `OracleCircuitBreaker`.

### 2.7 Health factor (`health.rs`)

```
weighted_collateral = Σ(col_i × (priceWad_i / 10^dec_i) × liqThresh_i / BPS)
total_debt_usd      = Σ(debt_i × (priceWad_i / 10^dec_i))
HF = weighted_collateral × WAD / total_debt_usd
```

Retourne `u128::MAX` si `total_debt_usd == 0`.

### 2.8 Host ABI (`host.rs`)

Bindings vers les fonctions hôte XRPL-WASM :

```rust
extern "C" {
    fn xrpl_read_state(key: *const u8, key_len: u32, buf: *mut u8, buf_len: u32) -> u32;
    fn xrpl_write_state(key: *const u8, key_len: u32, val: *const u8, val_len: u32);
    fn xrpl_get_caller(buf: *mut u8);
    fn xrpl_current_time() -> u64;
    fn xrpl_vault_withdraw(vault: *const u8, asset: u32, amount: u64);
    fn xrpl_transfer_to(account: *const u8, asset: u32, amount: u64);
    fn xrpl_accept();
    fn xrpl_rollback(code: u32) -> !;
    fn xrpl_set_return_value(ptr: *const u8, len: u32);
}
```

Le trait `HostContext` abstrait ces fonctions pour les tests (mock possible en dehors de WASM).

---

## 3. SDK TypeScript

### 3.1 Système de modules

| Package | Type de module | Raison |
|---------|---------------|--------|
| `sdk/` | CJS (CommonJS) | Importé par keeper et tests via require/interop |
| `keeper/` | CJS | Bot Node.js |
| `deploy/` | ESM | Scripts tsx (native ESM) |
| `tests/` | ESM | Vitest en mode ESM |

> **Point critique** : `AssetIndex` DOIT être un `enum` régulier (pas `const enum`). Un `const enum` efface l'objet runtime, cassant silencieusement `Object.values(AssetIndex)` en contexte ESM/CJS mixte.

### 3.2 `LendingClient` (`client.ts`)

Point central du SDK. Deux responsabilités :

**1. Lecture de l'état** :
- `readContractState(key: Uint8Array)` → `contract_info` RPC (XLS-101)
- `readOracleLedgerEntry(account, docId)` → `ledger_entry` RPC (XLS-47)

**2. Soumission de transactions** (ContractCall XLS-101) :
```
submitInvoke(functionName, args):
  1. Autofill via HTTP RPC (account_info) — évite incompatibilité api_version
  2. buildInvokeTx() → ContractCall { FunctionName (hex), Parameters (typed) }
  3. Sign via @transia/xrpl (fork qui connaît le codec ContractCall)
  4. Submit via HTTP RPC
  5. Poll validation jusqu'à 30s
```

**Encodage des arguments** — schéma par fonction :
```typescript
const FUNCTION_SCHEMAS = {
  supply:              ["UINT32", "UINT64"],  // 12 bytes
  borrow:              ["UINT32", "UINT64"],  // 12 bytes
  liquidate:           ["ACCOUNT", "UINT32", "UINT32", "UINT64"],  // 32 bytes
  set_vault:           ["UINT32"],            // 4 bytes
  // ...
};
```

Chaque paramètre est wrappé : `{ Parameter: { ParameterFlag: i, ParameterValue: { type, value } } }`.

**Key builders** (miroir exact du Rust) :
```typescript
marketInterestKey(assetIndex, field)   // "mkt:{i}:int:{field}"
userPositionKey(accountId, assetIndex, field)  // "pos:" + 20B binaire + ":{i}:{field}"
globalKey(field)                       // "glb:{field}"
```

### 3.3 Encodage des transactions ContractCall

```
FunctionName = toHex(utf8(functionName)).toUpperCase()
Parameters   = argsToParameters(functionName, args)  // typed array
Fee          = "1000000" (1 XRP — généreux pour contract calls)
ComputationAllowance = 1_000_000
```

### 3.4 `oracle.ts` — Lecture des prix

```
getAllPrices(client):
  1. client.readOracleLedgerEntry(DIA_ORACLE_ACCOUNT, DIA_DOCUMENT_ID)
  2. Vérif fraîcheur: now - LastUpdateTime > 300s → OracleStale
  3. Parsing PriceDataSeries (match par BaseAsset ticker)
  4. rawToWad(AssetPrice, Scale) = BigInt(price) × 10n ** BigInt(18 + scale)
  5. RLUSD: applyRlusdCircuitBreaker(priceWad) → WAD si [0.95, 1.05], sinon OracleCircuitBreaker
```

### 3.5 `health.ts` — Calculs financiers off-chain

Miroir TypeScript de `health.rs`. Utilisé par le keeper et les tests :

```typescript
// Valeur USD d'un actif
assetUsdValue(amount, priceWad, decimals) = amount * priceWad / 10n**decimals

// Health factor
calculateHealthFactor(positions, prices, markets) =
  Σ(col_i × price_i/dec_i × liqThresh_i/BPS) × WAD / Σ(debt_i × price_i/dec_i)

// Capacité d'emprunt
calculateBorrowCapacity(positions, prices, markets) =
  Σ(col_i × price_i/dec_i × ltv_i/BPS) − Σ(debt_i × price_i/dec_i)
```

### 3.6 `positions.ts` — Lecture de position complète

`getUserPosition(client, account)` :
1. Appel `get_user_position` via RPC (lecture du blob 144 bytes via `contract_info`)
2. Décode: 3 marchés × 48 bytes = `[collateral(u128) | actual_debt(u128) | supply_shares(u128)]`

> La fonction WASM `get_user_position` écrit son résultat via `set_return_value`, qui expose la donnée via `contract_info`. Le SDK lit ensuite via `readContractState`.

---

## 4. Keeper bot

### 4.1 Pipeline principal (`index.ts`)

```
XRPL ledgerClosed event (chaque ~3-5s)
  ↓
OracleWatcher.onLedgerClose()
  → getAllPrices(client)
  → Si changement > threshold: émet PriceUpdate
  ↓
PositionMonitor.scan(prices)
  → Pour chaque account in config.monitoredAccounts:
      getUserPosition() + calculateHealthFactor()
  → Si HF < WAD: émet LiquidationOpportunity
  ↓
filterProfitable(opportunities, prices)
  → Estimation collatéral séquestrable
  → profit = bonus_collateral_usd − (gasCostDrops × xrpPrice / 1e6)
  → Garde seulement netProfit ≥ config.minProfitUsd
  ↓
Liquidator.executeBatch(profitable)
  → Dry-run: log seulement
  → Live: liquidate(client, borrower, debtAsset, colAsset, amount)
```

### 4.2 Configuration (`config.ts`)

Toutes les valeurs tunable viennent de variables d'environnement :

```typescript
KEEPER_WALLET_SECRET      // seed du wallet (requis hors dry-run)
CONTROLLER_ADDRESS        // adresse r- du contrat (requis)
MONITORED_ACCOUNTS        // CSV de r-addresses à surveiller
XRPL_WSS_URL              // WebSocket URL (défaut: wss://alphanet.nerdnest.xyz)
MIN_PROFIT_USD            // profit min en USD entier (défaut: 10)
LIQUIDATION_GAS_DROPS     // coût estimé tx en drops (défaut: 12)
LIQUIDATION_COOLDOWN_MS   // cooldown entre exécutions en ms (défaut: 4000)
```

---

## 5. Tests E2E

### 5.1 SimulatedLedger (`tests/helpers/simulated-ledger.ts`)

Simulateur déterministe in-memory qui reproduit **exactement** l'arithmétique du contrat Rust :

- Stockage : `Map<string, bigint>` avec le même schéma de clés ASCII que le Rust
- WAD math : miroir exact en BigInt de `math.rs`
- `updateInterestIndexes()` : reproduit fidèlement le bug §9.1 (supply_rate_bps passé à la place de reserve_factor)
- `buildOracleEntry()` : utilise `Date.now()/1000` (pas le timestamp simulé) pour éviter les erreurs de fraîcheur oracle

Le `createMockClient(account)` stub `LendingClient` pour que le SDK lise depuis la Map in-memory.

### 5.2 Scenario full-lifecycle (`tests/scenarios/full-lifecycle.ts`)

14 étapes : supply → collateral → borrow → intérêts → repay → chute de prix → liquidation → withdraw

Point clé de l'étape 14 (withdraw précis) :
```typescript
// Évite le "phantom residue" du résidu entier
const maxShares = (totalSupply * WAD) / supplyIndex;  // floor division
withdraw(min(userShares, maxShares));
```

---

## 6. Scripts de déploiement

### 6.1 Ordre de déploiement

```bash
# 1. Déployer le contrat WASM
DEPLOYER_SECRET=sXXX tsx deploy-controller.ts
# → Compile Rust, ContractCreate, extrait contractAddress → deployed.json

# 2. Créer les vaults + enregistrer les vault accounts
DEPLOYER_SECRET=sXXX tsx setup-markets.ts
# → VaultCreate × 3, registerVault × 3 (set_vault), → deployed.json mis à jour

# 3. Configurer les paramètres de marché
DEPLOYER_SECRET=sXXX tsx configure-markets.ts
# → set_market_config + set_oracle_config × 3 marchés

# 4. Vérifier l'oracle
tsx setup-oracle.ts
# → Lecture oracle DIA, vérif fraîcheur + circuit breaker
```

### 6.2 `shared.ts` — Utilitaires partagés

- `loadDeployEnv()` : lit `DEPLOYER_SECRET`, `XRPL_WSS_URL`, `RLUSD_ISSUER`, `WBTC_ISSUER`
- `loadDeployedState() / saveDeployedState()` : JSON à `deploy/deployed.json`
- `extractCreatedAccount(meta)` : parse les `AffectedNodes` pour trouver le nouveau `AccountRoot`
- `extractCreatedNodeIndex(meta, type)` : idem pour un `LedgerEntryType` donné

---

## 7. Gestion des erreurs

### Codes d'erreur du contrat (`errors.rs`)

```
1xx — Général:      MathOverflow(100), InvalidAmount(101), InvalidAsset(102), Unauthorized(104)
2xx — Vault:        InsufficientLiquidity(200), WithdrawExceedsBalance(202)
3xx — Collatéral:   CollateralNotEnabled(300), WithdrawWouldLiquidate(302)
4xx — Emprunt:      BorrowCapacityExceeded(401), InsufficientBorrowLiquidity(402)
5xx — Liquidation:  PositionHealthy(500), MaxLiquidationExceeded(501)
6xx — Oracle:       OracleStale(600), OraclePriceZero(601), OracleCircuitBreaker(603)
7xx — Intérêts:     InterestAccrualFailed(700)
8xx — Marchés:      MarketNotConfigured(800)
```

Le SDK TypeScript expose `LendingError extends Error` avec `code: LendingErrorCode` qui mirore ces codes.

---

## 8. Dépendances clés

| Package | Rôle |
|---------|------|
| `xrpl` (v4) | Client XRPL officiel (lecture state, WebSocket) |
| `@transia/xrpl` | Fork de xrpl.js avec support ContractCall (XLS-101) pour signer les txs |
| `typescript` (v5.5) | Typage statique |
| `vitest` (v2) | Tests unitaires et d'intégration |
| `tsx` | Runner TypeScript ESM pour les scripts deploy |
| `dotenv` | Chargement `.env` |

> `@transia/xrpl` est utilisé **exclusivement** pour signer les transactions ContractCall (le binaire codec XLS-101 n'est pas dans le xrpl.js officiel v4). Pour toutes les autres opérations (lecture, WebSocket), xrpl.js officiel est utilisé.
