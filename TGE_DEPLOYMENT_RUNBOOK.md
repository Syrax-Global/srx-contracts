# SRX Token — TGE Deployment Runbook
## Classification: Internal — Ops Team Only
## Security finding: SC-005 (Medium) — Addresses non-atomic TGE deployment risk

---

## Overview

Token Genesis Event (TGE) distributes 10,000,000,000 SRX to all allocation recipients
and starts every vesting clock. **This is irreversible.** Once `genesis()` is called,
the token supply is minted and cannot be un-minted.

The TGE is executed by a single script (`06_execute_tge.js`) that runs five steps (0 to 4)
sequentially in a single process. The steps are NOT a single on-chain transaction — each
step is a separate blockchain transaction. If the script fails mid-execution, recovery
procedures in this runbook must be followed.

---

## Execution Architecture

```
06_execute_tge.js runs:

  Step 0:  TGEDistributor.setAllocations()   ← idempotent, safe to re-run
  Step 1:  SRXToken.genesis(tgeDistributor)  ← IRREVERSIBLE — mints 10B SRX
  Step 2:  TGEDistributor.distribute()       ← IRREVERSIBLE — sends to all recipients
  Step 3:  Timelock.executeBatch() × 2       ← declares every vault's grant, then starts
                                               every vesting clock (6 vaults; scheduled in
                                               03_deploy_vesting, at least the Timelock delay earlier)
  Step 4:  SRXStaking.notifyRewardAmount()   ← registers incentive pool (accounting only)
```

⭐ **The launch vaults' admin is the SRXTimelock (Jared, 30 Sep 2026).** A vault's admin can
`revoke()` it and send its whole unvested remainder to any address, so that power sits
behind the 48-hour delay, never with the Safe. The admin also declares each grant and starts
each clock, so `03_deploy_vesting` **schedules** both as Timelock operations
(`scripts/deploy/lib/vaultOps.js`) and Step 3 above **executes** them, in the same Safe batch
as `distribute()`. ⛔ **On mainnet, run the Safe batch from `03_deploy_vesting` at least
48 hours before launch day.** `06_execute_tge.js` checks that both operations are scheduled
and ready BEFORE Step 0. If they are not (or the Genesis sale total changed since they were
scheduled), it stops, names the time they become ready, and nothing is sent: no
`setAllocations`, no `genesis`, no `distribute`.

Steps 1–3 are irreversible once executed. Step 4 has no on-chain state lock but should
be treated as part of the same sequence for accounting integrity.

### ⭐ The Genesis round is funded from the seed allocation (Jared, 10 and 30 Sep 2026)

The 4% seed allocation (400M SRX) funds the Genesis round (`PreSaleRound`, deployed by
`10_deploy_presale.js`). At launch the Genesis contract receives **exactly what it sold**
(its `totalAllocated()`, bonus included) and the seed vault receives the rest. Both are on the
seed schedule (0% at launch, 273 days held, 730 days of release), so the published allocation
and the 5% float are unchanged (`scripts/deploy/lib/genesis_seed.js`).

⛔ **Never more than it sold.** `PreSaleRound.recoverSRX()` returns anything above what buyers
are owed, unlocked (since 16 Oct, internal audit L6, it never takes the SRX that buyers are
owed), so anything beyond what buyers are owed would be launch-day float in all but name.

The order this imposes:
1. `01_deploy_token`, then `10_deploy_presale` against that token. The round runs.
2. **Close the round (`finalize()`) before `03_deploy_vesting`.** Step 3 schedules the seed
   vault's grant (400M minus what was sold), and it refuses, sending nothing, while the round is
   open. Set `PRESALE_ROUND_<NETWORK>` to the Genesis contract, or to `none` if there is no
   round. On a real network, an unset value is an error.
3. ⛔ **No refund after Step 3.** A refund changes the amount sold, so the grant scheduled in
   Step 3 no longer matches, and Step 6 refuses (the operation ids differ). If one is
   unavoidable, re-run Step 3 and wait the Timelock delay again.
4. `06_execute_tge` sends the Genesis contract its amount. **Straight after, run
   `06b_genesis_vaults.js`, before `maxWalletBalance` is switched on (PSR-09).** It creates
   each buyer's vault and starts its clock. It needs one Safe batch per 20 buyers
   (`GENESIS_VAULT_CHUNK`), so re-run it until it prints `GENESIS VAULTS COMPLETE`. It refuses
   if the Genesis contract holds more or less than its buyers are owed.
5. `verify_tge.js` then checks every buyer's vault and that the Genesis contract holds 0 SRX.

The manifest (`deploy/addresses.<network>.json`) carries two rows for the seed allocation,
`SeedInvestors` and `Genesis`, with the split amounts.

---

## Pre-Mainnet Checklist

Complete EVERY item and get sign-off from two team members before running.

### Smart Contract Readiness
- [ ] External security audit complete
- [ ] All contracts deployed to mainnet and verified on Etherscan
- [ ] All contract addresses recorded in deployment registry
- [ ] The role hand-over done as `MULTISIG_SPEC.md` describes (`migrate_roles.js`, then `verify_roles.js`
      green): core contracts behind the Timelock, the Safe keeping only emergency pause, the veto and
      the wind-down switch (`WIND_DOWN_ROLE`) — SC-006 requirement
- [ ] Deployer EOA has all privileged roles REVOKED post-deploy-role-transfer
- [ ] `SRXToken.genesisComplete()` returns `false`
- [ ] `TGEDistributor.distributed()` returns `false`
- [ ] All 6 vesting vaults deployed and verified — `tgeTriggered()` returns `false` on each

### Allocation Verification
- [ ] `TGEDistributor.getAllocations()` matches `docs/TOKENOMICS.md` exactly (generated from `00_config.js`)
- [ ] Every row of `TGE_PLAN` (12) has the correct contract/wallet address, plus the `Genesis`
      row (the Genesis contract) when a Genesis round sold anything
- [ ] The Genesis round is closed (`finalized()` returns `true`) and no refund has been recorded
      since `03_deploy_vesting` ran
- [ ] Total allocation sum = 10,000,000,000 SRX (verify via `00_config.js` ALLOCATIONS)
- [ ] Exactly 500,000,000 SRX (5%) is transferable at launch: the presale launch tranche, the
      official pool and the market maker — and `scripts/ops/verify_tge.js` reports it after TGE
- [ ] `WALLET_PRESALE`, `WALLET_LIQUIDITY` and `WALLET_MARKET_MAKER` are each a **multi-signature
      wallet** (a Safe). The TGE gate refuses a single-key wallet on a real network
- [ ] StabilisationFund address set as strategic reserve destination (NOT a raw wallet)
- [ ] Vesting vault addresses in `.env` match deployed vault addresses on Etherscan

### Environment Setup
- [ ] `.env` file contains all required vars for mainnet network
- [ ] `SRX_TOKEN_MAINNET`, `TGE_DISTRIBUTOR_MAINNET`, `TREASURY_MAINNET`
- [ ] `STABILISATION_FUND_MAINNET`, `STAKING_MAINNET`
- [ ] `VESTING_FOUNDERS_MAINNET`, `VESTING_CORE_TEAM_MAINNET`, `VESTING_SEED_MAINNET`
- [ ] `VESTING_PRESALE_MAINNET`, `VESTING_ECOSYSTEM_MAINNET`, `VESTING_LIQUIDITY_RESERVE_MAINNET`
- [ ] `WALLET_PRESALE`, `WALLET_LIQUIDITY`, `WALLET_MARKET_MAKER` (multi-signature wallets)
- [ ] Deployer wallet has sufficient ETH for gas (estimate: 0.05–0.15 ETH at 30 gwei)
- [ ] Gas price checked — do NOT execute during network congestion (>50 gwei)

### Security
- [ ] Deployer private key is on a hardware wallet (Ledger/Trezor) — NOT a hot wallet
- [ ] TGE execution machine is isolated — not used for any other purpose
- [ ] At least 2 team members present during execution
- [ ] Recovery procedure reviewed by both team members (see below)
- [ ] Block explorer tabs open for every deployed contract before starting (the suite is listed in
      `docs/ADDRESSES.md`)

---

## Execution Procedure

### Step 1 — Final verification before running

```bash
# Confirm genesis not yet complete (must return false)
npx hardhat console --network mainnet
> const t = await ethers.getContractAt("SRXToken", process.env.SRX_TOKEN_MAINNET)
> await t.genesisComplete()    // must be: false

# Confirm distribution not yet executed (must return false)
> const d = await ethers.getContractAt("TGEDistributor", process.env.TGE_DISTRIBUTOR_MAINNET)
> await d.distributed()        // must be: false
```

### Step 2 — Run TGE script

```bash
npx hardhat run scripts/deploy/06_execute_tge.js --network mainnet
```

The script will:
1. Print a pre-flight report with all addresses
2. Prompt for confirmation: type `yes` to proceed
3. Execute steps 0–4 with console output at each stage
4. Print a summary checklist on success

**Expected total time:** 3–7 minutes at normal gas prices (six calls: `setAllocations`, `genesis`,
`distribute`, two Timelock `executeBatch` calls, `notifyRewardAmount`; on mainnet the first five
go in one Safe batch).

### Step 2b — Genesis buyers' vaults (straight after, before `maxWalletBalance` is switched on)

```bash
npx hardhat run scripts/deploy/06b_genesis_vaults.js --network mainnet
```

Re-run after the Safe executes each batch, until it prints `GENESIS VAULTS COMPLETE`.

### Step 3 — Post-execution verification (run immediately after)

```bash
npx hardhat run scripts/ops/verify_tge.js --network mainnet
```

This script verifies:
- `token.totalSupply()` = 10,000,000,000 SRX
- `tgeDistributor.balanceOf()` = 0 (fully distributed)
- Each vault's `tgeTriggered()` = true
- Each vault's `tgeTimestamp()` is the correct block timestamp
- StabilisationFund received 1,500,000,000 SRX
- Staking contract `rewardPool()` = 1,700,000,000 SRX

---

## Recovery Procedures

### Scenario A: Script fails BEFORE Step 1 (genesis not called)

**Symptom:** Error in Step 0 or startup. `genesisComplete()` still false.

**Recovery:** Fix the issue (env var, gas, RPC) and re-run the script from the start.
Step 0 (`setAllocations`) is idempotent — safe to repeat.

---

### Scenario B: Script fails AFTER Step 1 but BEFORE Step 2

**Symptom:** `genesisComplete()` = true, `distributed()` = false.
TGEDistributor holds 10,000,000,000 SRX.

**Recovery:**
1. Do NOT panic — tokens are held in the TGEDistributor, not lost
2. Fix the issue causing the failure
3. Re-run the script — its `genesisComplete` check will skip genesis
4. Step 0 will re-confirm allocations, Step 2 will distribute
5. Verify via `verify_tge.js`

---

### Scenario C: Script fails AFTER Step 2 but BEFORE the vault setup in Step 3 completes

**Symptom:** `distributed()` = true. The vaults hold their tokens but `tgeTriggered()` is still
false (and `expectedAllocation()` may be unset). The vault admin is the SRXTimelock, so a call to
`vault.triggerTGE()` from the Safe or the deployer reverts `OnlyAdmin`; do not try it.

**Recovery:**
1. Check which Timelock operations are done. `Timelock.executeBatch` is atomic, so each of the two
   operations (declare every grant, then start every clock) either ran for all vaults or for none:
```bash
npx hardhat console --network mainnet
> const vault = await ethers.getContractAt("VestingVault", "<VAULT_ADDRESS>")
> await vault.tgeTriggered()   // false = the TRIGGER operation has not executed
```
2. Re-run `06_execute_tge.js`. It detects what is done, skips it, and executes the remaining
   operation(s) with the exact arguments built by `scripts/deploy/lib/vaultOps.js` (execution is open
   to anyone once the operation is ready).
3. Continue with Step 4 if not yet executed:
```bash
> const staking = await ethers.getContractAt("SRXStaking", process.env.STAKING_MAINNET)
> const bal = await token.balanceOf(process.env.STAKING_MAINNET)
> await staking.notifyRewardAmount(bal)
```
4. Run `verify_tge.js` to confirm full completion

---

### Scenario D: Script fails AFTER Step 3, Step 4 not executed

**Symptom:** All vaults triggered, staking `rewardPool()` = 0.

**Recovery:** Call `notifyRewardAmount()` manually (Step 4 is accounting-only):
```bash
npx hardhat console --network mainnet
> const staking = await ethers.getContractAt("SRXStaking", process.env.STAKING_MAINNET)
> const bal = await token.balanceOf(process.env.STAKING_MAINNET)
> await staking.notifyRewardAmount(bal)
> await staking.rewardPool()   // must be > 0
```

---

### Scenario E: Wrong vault address in .env — vault gets wrong amount

**Symptom:** Tokens sent to incorrect address (not a deployed VestingVault).

**Resolution:** This cannot be recovered on-chain. Tokens sent to a non-contract address
are lost. Tokens sent to a wrong contract may be recoverable via admin if the contract
has a rescue function.

**Prevention:** Triple-check every vault address against Etherscan before executing.
This is why the pre-flight checklist requires 2 team members to sign off on addresses.

---

## Post-TGE Actions (After verify_tge.js passes)

- [ ] Announce TGE to community with all allocation addresses for public transparency
- [ ] Governance proposal to set staking emission rate:
      `staking.setRewardRate(13_500_000_000_000_000_000)` — ~4-year distribution
- [ ] Enable trading on DEXes (add liquidity to pools)
- [ ] The Genesis round (`PreSaleRound`) is run and closed before launch (see the ordering above); there is no
      `openRound()` function to call at TGE
- [ ] Confirm GuardianModule (`08_deploy_guardian.js`) is already deployed and wired. It is
      deployed before the role hand-over, not after TGE, and holds `PAUSER_ROLE` on SRXToken,
      SRXStaking, SRXTreasury, FeeController and StabilisationFund (`verify_roles.js` checks the
      roles; adding the module registry and breaker settings to that check is being built, L16)
- [ ] Run the bridge circuit-breaker monitor `scripts/ops/circuit_breaker_monitor.js`. The
      breaker covers the bridge only, and the monitor reports bridge-outs (counting returns too
      is being built, L14)
- [ ] Revoke deployer EOA from all remaining roles within 24 hours of TGE

---

## Key Contract Addresses (update when mainnet deployed)

Testnet addresses are in [`docs/ADDRESSES.md`](docs/ADDRESSES.md), generated from
`deployments/<network>.json`. Mainnet addresses go there the same way after deployment; do not
copy addresses into this runbook.

---

*Runbook created: 19 May 2026 | SC-005 remediation*
*Review required before mainnet TGE execution*
