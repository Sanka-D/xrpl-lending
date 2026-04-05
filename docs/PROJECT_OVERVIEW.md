# XRPL Lending Protocol V1 — Vue d'ensemble du projet

## 1. Résumé

Le protocole de lending XRPL est un protocole de prêt/emprunt décentralisé déployé sur la blockchain XRPL (XRP Ledger). Il exploite trois standards émergents de l'XRPL pour fournir des fonctionnalités comparables à Aave ou Compound, mais nativement sur l'XRPL.

### Standards utilisés

| Standard | Rôle |
|----------|------|
| **XLS-65** | Vaults natifs — conservent les actifs déposés on-chain sans compte d'escrow séparé |
| **XLS-101** | Exécution de smart contracts — upload de bytecode WASM, appel via transactions `ContractCall` |
| **XLS-47** | Oracle on-chain — flux de prix DIA stockés comme objets du registre XRPL |

### Périmètre V1

3 marchés : **XRP**, **RLUSD**, **wBTC**

Réseau cible : **AlphaNet** XRPL (`wss://alphanet.nerdnest.xyz`)

---

## 2. Ce que permet le protocole

### Pour les fournisseurs de liquidité
- Déposer des actifs dans un vault de liquidité et recevoir des **parts (supply shares)**
- Les parts s'apprécient au fil du temps grâce aux intérêts payés par les emprunteurs
- Retirer à tout moment en brûlant des parts

### Pour les emprunteurs
- Déposer des actifs en **collatéral** (bloqué, non productif d'intérêts)
- Emprunter d'autres actifs jusqu'à une limite LTV (Loan-to-Value)
- Rembourser la dette (principal + intérêts accrués)

### Pour les liquidateurs
- Surveiller les positions dont le **health factor** tombe sous 1.0
- Rembourser jusqu'à 50% de la dette d'une position insolvable
- Recevoir le collatéral correspondant + un **bonus** (4–6.5% selon l'actif)

---

## 3. Architecture globale

```
                    ┌──────────────────────────────────────────────────────┐
                    │                        XRPL Ledger                   │
                    │                                                      │
  Utilisateur       │  ┌─────────────────┐   ┌────────────────┐           │
  (browser/CLI)─────┼─▶│  ContractCall   │──▶│ Controller     │           │
                    │  │ (XLS-101)       │   │ WASM           │──▶ État   │
  SDK               │  └─────────────────┘   │ (supply/borrow/│    clés   │
  (xrpl-lending-sdk)│                        │  liquidate…)   │           │
       │            │  ┌─────────────────┐   └────────────────┘           │
       ▼            │  │ Oracle DIA      │          │                      │
  LendingClient     │  │ (XLS-47)        │◀─────────┘ (lecture prix)      │
       │            │  └─────────────────┘                                 │
       ▼            │                                                      │
  Keeper bot        │  ┌─────────────────┐                                │
  (liquidation)─────┼─▶│ Vaults (XLS-65) │ (garde des actifs)            │
                    │  └─────────────────┘                                │
                    └──────────────────────────────────────────────────────┘
```

### Composants

| Composant | Technologie | Rôle |
|-----------|-------------|------|
| Smart contract | Rust → WASM32 | Logique on-chain (supply, borrow, liquidate…) |
| SDK TypeScript | Node.js / xrpl.js | Client read/write pour le contract |
| Keeper bot | TypeScript | Bot off-chain de surveillance et liquidation |
| Deploy scripts | TypeScript / tsx | Scripts de déploiement sur AlphaNet |
| Tests E2E | TypeScript / Vitest | Tests de simulation (sans réseau) |

---

## 4. Flux d'exécution d'une opération

Chaque opération d'écriture suit ce flux :

1. **Côté client** : le SDK construit une transaction `ContractCall` (XLS-101) avec le nom de la fonction et les arguments encodés en little-endian
2. **XRPL runtime** : exécute le bytecode WASM exporté
3. **WASM** : lit l'état via `host::read_state`, lit les prix via l'oracle DIA
4. **Logique métier** : accrual des intérêts → validation → mutation de l'état
5. **WASM** : écrit l'état mis à jour via `host::write_state`
6. **Résultat** : `accept_tx()` si succès, `rollback_tx(code_erreur)` si échec

### Exemple : emprunter 8 000 RLUSD

```
1. SDK.borrow(RLUSD, 8_000_000_000n)
   → ContractCall { FunctionName: "626f72726f77", Parameters: [UINT32(1), UINT64(8000000000)] }

2. WASM handle_borrow():
   a. Accrual des intérêts pour RLUSD
   b. Calcul du solde collatéral (ex: 10 000 XRP × $2.00 × LTV 80% = $16 000)
   c. Vérification : $8 000 ≤ $16 000 ✓
   d. Vérification liquidité vault : 8 000 RLUSD disponibles ✓
   e. vault_withdraw + transfer_to(caller)
   f. Mise à jour total_borrows += 8 000, total_supply -= 8 000

3. État stocké: pos[caller][RLUSD].debt = to_scaled_debt(8000, borrowIndex)
```

---

## 5. Modèle économique

### Taux d'intérêt (kinked two-slope)

Chaque marché a un modèle à deux pentes avec un taux optimal :

- En dessous du taux d'utilisation optimal `U_opt` : taux = base + (U/U_opt) × slope1
- Au-dessus : taux = base + slope1 + ((U-U_opt)/(1-U_opt)) × slope2

| Paramètre | XRP | RLUSD | wBTC |
|-----------|-----|-------|------|
| LTV (max emprunt) | 75% | 80% | 73% |
| Seuil liquidation | 80% | 85% | 78% |
| Bonus liquidation | 5% | 4% | 6.5% |
| Reserve factor | 20% | 10% | 20% |
| Utilisation optimale | 80% | 90% | 45% |
| Slope1 | 4% | 4% | 7% |
| Slope2 | 300% | 60% | 300% |

### Health Factor

Le health factor mesure la solvabilité d'une position :

```
HF = Σ(collatéral_i × prix_i × seuil_liq_i) / Σ(dette_i × prix_i)
```

- `HF ≥ 1.0` → position saine
- `HF < 1.0` → position liquidable

---

## 6. Oracle de prix (DIA / XLS-47)

Les prix proviennent d'un oracle DIA stocké on-chain via XLS-47 :
- Compte oracle : `rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7`
- Document ID : `42`
- Fraîcheur maximale : **300 secondes** (5 minutes)

**Circuit breaker RLUSD** : si le prix DIA de RLUSD est entre $0.95 et $1.05, le protocole force `price = $1.00`. Si hors de cette plage → toutes les opérations RLUSD échouent avec `OracleCircuitBreaker`.

---

## 7. Keeper bot (liquidation automatique)

Le keeper surveille les positions toutes les ~3-5 secondes (à chaque fermeture de ledger) :

```
Souscription ledgerClosed
  → Lecture oracle (prix)
      → Si changement de prix significatif : scan des positions surveillées
          → Pour chaque position : calcul HF
              → Si HF < 1.0 : estimation de rentabilité
                  → Si profit net ≥ seuil : exécution de la liquidation
```

Configuration par variables d'environnement :
- `KEEPER_WALLET_SECRET` — seed du wallet liquidateur
- `CONTROLLER_ADDRESS` — adresse du contrat
- `MONITORED_ACCOUNTS` — comptes à surveiller (CSV)
- `XRPL_WSS_URL` — URL WebSocket (défaut: `wss://alphanet.nerdnest.xyz`)
- `MIN_PROFIT_USD` — profit minimum en USD pour exécuter une liquidation

---

## 8. Déploiement sur AlphaNet

### Ordre de déploiement

```
1. tsx deploy-controller.ts    # Compile et déploie le WASM, extrait contractAddress
2. tsx setup-markets.ts        # Crée 3 vaults XLS-65, enregistre les vault accounts
3. tsx configure-markets.ts    # Configure les paramètres de marché et l'oracle
4. tsx setup-oracle.ts         # Vérifie que l'oracle DIA est accessible et frais
```

Variables d'environnement requises :

```bash
DEPLOYER_SECRET=sXXX...        # Seed du wallet déployeur
XRPL_WSS_URL=wss://alphanet.nerdnest.xyz  # URL AlphaNet (défaut si non défini)
RLUSD_ISSUER=rXXX...           # Adresse émetteur RLUSD (optionnel, créé auto)
WBTC_ISSUER=rXXX...            # Adresse émetteur wBTC (optionnel, créé auto)
FAUCET_URL=http://...          # URL du faucet pour financer les comptes
```

L'état de déploiement est persisté dans `deploy/deployed.json`.

---

## 9. Limitations connues V1

1. **Bug supply_rate**: le paramètre `reserve_factor` est substitué par `supply_rate_bps` dans le calcul des intérêts → le protocol gagne moins de réserves que configuré
2. **Résidu entier dans les dettes**: les arrondi entier lors de remboursements partiels laissent ~1-8 unités de "phantom borrows"
3. **Approximation Taylor des intérêts composés**: 2 termes de Taylor → erreur ~57% pour 300% APY sur 1 an (acceptable pour le risque du protocole)
4. **Pas de gouvernance V1**: tous les paramètres sont des constantes compilées dans le WASM
