

## Contexte de notre projet

On developpe un **protocole de lending DeFi** (supply/borrow/repay/liquidate) en tant que smart contract WASM sur XRPL, en utilisant le framework **Bedrock** (XLS-101).

Le contrat est ecrit en Rust, compile en `wasm32-unknown-unknown`, et deploye via `ContractCreate`. L'execution des fonctions via `ContractCall` **fonctionne** - toutes les fonctions WASM s'executent, les host functions `trace`, `trace_num`, `get_tx_field`, `accept`, `rollback` marchent correctement.

**Le probleme : aucun mecanisme de persistence d'etat ne fonctionne.** Les fonctions qui dependent d'un etat persiste entre transactions (borrow, repay) echouent car elles lisent toujours des zeros.

### Environnement & Bedrock CLI
- **Bedrock CLI** : on utilise le CLI Bedrock (`bedrock node start`) pour gerer le noeud local. Le CLI demarre le container Docker et lance `/app/xrpld -a` (mode standalone) directement, sans passer par l'entrypoint.sh du container. Il lance aussi un "ledger daemon" qui appelle `ledger_accept` toutes les secondes pour simuler l'avancement des ledgers.
- **Image Docker** : `transia/cluster:f5d78179c9d1fbaf8bff8b77a052e263df90faa1`
- **Version rippled** : `3.2.0-b0+f5d78179` (branch `alphanet-develop`)
- **Mode** : standalone (`/app/xrpld -a`)
- **network_id** : 63456
- **Deploiement** : `bedrock deploy` ou manuellement via `ContractCreate` signe avec `@transia/xrpl` (fork qui connait l'encodage binaire XLS-101)
- **Config** : `.bedrock/node-config/xrpld.cfg` - config generee par le CLI, pas de section `[standalone]` explicite
- **Repo** : https://github.com/Sanka-D/xrpl-lending (les fichiers cles sont `contracts/lending-controller/src/host.rs`, `deploy/test-e2e-local.ts`, `deploy/test-bedrock-api.ts`)

---

## Question 1 : `update_data(ptr, len)` retourne 0 mais ne persiste rien

On appelle `update_data` (importee depuis l'environnement host) pour ecrire un blob d'etat dans le Contract ledger entry. La fonction **retourne 0** (succes), mais :

- Les metadata de la transaction (`account_tx`) ne montrent **que des modifications `AccountRoot`**, jamais de modification sur l'entree `Contract`
- Le champ `PreviousTxnID` du Contract entry ne change pas
- Un appel ulterieur a `get_current_ledger_obj_field(sfData = (7<<16)|27)` retourne **0 bytes** - les donnees ne sont pas la

**Diagnostic fait** : on a un probe WASM qui ecrit un sentinel `[0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78]` via `update_data`, puis dans une **2eme transaction** on lit via `get_current_ledger_obj_field(sfData)`. WasmTrace montre `R:0` - rien n'a ete persiste.

**Question** : Est-ce que `update_data` est implemente et fonctionnel dans ce build ? Y a-t-il une condition prealable (initialisation du champ `Data` au moment du `ContractCreate`, taille maximale, flag specifique) pour que les donnees soient effectivement ecrites dans le ledger ?

---

## Question 2 : `set_data_object_field` retourne -12 ("Too many data changes")

On a aussi essaye le **KV store** via `set_data_object_field(account_ptr, field_name_ptr, field_name_len, value_ptr, value_len, type_id)`. La fonction retourne systematiquement **-12**.

D'apres les logs Docker, -12 correspond a `"SetContractData failed: Too many data changes"`. On comprend que c'est lie a un **budget de modifications par transaction** qui est a 0.

On a tente de fixer ce budget via le champ `ExtensionSizeLimit` (UInt32, nth=70, defini dans `@transia/ripple-binary-codec`) mais il est rejete comme **"disallowed location"** sur :
- `ContractCall`
- `ContractModify`
- `ContractCreate`

**Question** : Comment configurer le budget de data changes pour autoriser `set_data_object_field` ? Est-ce que `ExtensionSizeLimit` est le bon champ ? Si oui, sur quel type de transaction doit-il etre place ? Si non, quel mecanisme controle ce budget dans le build `f5d78179` ?

---

## Question 3 : Quelle est la bonne image Docker / version pour le state persistence ?

On a aussi teste l'image `transia/cluster:204442f5` (Mar 2026, branch `options-sidechain`) mais elle est **`amendmentBlocked`** au demarrage en standalone - meme `ledger_accept` est refuse, le noeud est inutilisable.

**Question** : Quelle image `transia/cluster` (ou quel tag/commit) est recommandee pour developper et tester des smart contracts WASM **avec state persistence fonctionnel** ? Y a-t-il un exemple de contrat WASM qui persiste des donnees entre transactions qu'on pourrait utiliser comme reference ?

---

## Resume des host functions testees

| Host function | Signature WASM | Resultat | Etat |
|---|---|---|---|
| `update_data(ptr, len) -> i32` | Blob write | Retourne 0, **aucune donnee persistee** | Non fonctionnel |
| `get_current_ledger_obj_field(field, ptr, len) -> i32` | Blob read | Retourne 0 bytes pour sfData | Coherent (rien a lire) |
| `set_data_object_field(acct, name, nlen, val, vlen, type) -> i32` | KV write | Retourne **-12** | Budget = 0 |
| `get_data_object_field(acct, name, nlen, ptr, len, type) -> i32` | KV read | Retourne **-12** | Budget = 0 |
| `trace(tag, tlen, val, vlen, dtype) -> i32` | Debug | **Fonctionne** | OK |
| `trace_num(tag, tlen, num) -> i32` | Debug | **Fonctionne** | OK |
| `get_tx_field(field_code, ptr, len) -> i32` | TX read | **Fonctionne** | OK |
| `accept(ptr, len, code) -> i64` | Accept TX | **Fonctionne** | OK |
| `rollback(ptr, len, code) -> i64` | Rollback TX | **Fonctionne** | OK |
| `function_param(idx, type, ptr, len) -> i32` | Param read | Non teste (Parameters crash sur Bedrock) | Inconnu |
