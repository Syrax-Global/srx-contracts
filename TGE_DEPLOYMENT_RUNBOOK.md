# SRX Token — TGE Deployment Runbook
## Classification: Internal — Ops Team Only
## Security finding: SC-005 (Medium) — Addresses non-atomic TGE deployment risk

---

## Overview

Token Genesis Event (TGE) distributes 10,000,000,000 SRX to all allocation recipients
and starts every vesting clock. **This is irreversible.** Once `genesis()` is called,
the token supply is minted and cannot be un-minted.

The TGE is executed by a single script (`06_execute_tge.js`) that runs four steps
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
  Step 3:  VestingVault[n].triggerTGE()      ← starts vesting clocks (5 vaults, 5 txs)
  Step 4:  SRXStaking.notifyRewardAmount()   ← registers incentive pool (accounting only)
```

Steps 1–3 are irreversible once executed. Step 4 has no on-chain state lock but should
be treated as part of the same sequence for accounting integrity.

---

## Pre-Mainnet Checklist

Complete EVERY item and get sign-off from two team members before running.

### Smart Contract Readiness
- [ ] External security audit complete (Halborn or equiv.)
- [ ] All contracts deployed to mainnet and verified on Etherscan
- [ ] All contract addresses recorded in deployment registry
- [ ] All admin roles transferred to Gnosis Safe (≥3/5 multisig) — SC-006 requirement
- [ ] Deployer EOA has all privileged roles REVOKED post-deploy-role-transfer
- [ ] `SRXToken.genesisComplete()` returns `false`
- [ ] `TGEDistributor.distributed()` returns `false`
- [ ] All 5 vesting vaults deployed and verified — `tgeTriggered()` returns `false` on each

### Allocation Verification
- [ ] `TGEDistributor.getAllocations()` matches tokenomics document exactly
- [ ] All 9 allocation destinations are the correct contract/wallet addresses
- [ ] Total allocation sum = 10,000,000,000 SRX (verify via `00_config.js` ALLOCATIONS)
- [ ] StabilisationFund address set as strategic reserve destination (NOT a raw wallet)
- [ ] Vesting vault addresses in `.env` match deployed vault addresses on Etherscan

### Environment Setup
- [ ] `.env` file contains all required vars for mainnet network
- [ ] `SRX_TOKEN_MAINNET`, `TGE_DISTRIBUTOR_MAINNET`, `TREASURY_MAINNET`
- [ ] `STABILISATION_FUND_MAINNET`, `STAKING_MAINNET`
- [ ] `VESTING_FOUNDERS_MAINNET`, `VESTING_CORE_TEAM_MAINNET`, `VESTING_SEED_MAINNET`
- [ ] `VESTING_PRESALE_MAINNET`, `VESTING_ECOSYSTEM_MAINNET`
- [ ] Deployer wallet has sufficient ETH for gas (estimate: 0.05–0.15 ETH at 30 gwei)
- [ ] Gas price checked — do NOT execute during network congestion (>50 gwei)

### Security
- [ ] Deployer private key is on a hardware wallet (Ledger/Trezor) — NOT a hot wallet
- [ ] TGE execution machine is isolated — not used for any other purpose
- [ ] At least 2 team members present during execution
- [ ] Recovery procedure reviewed by both team members (see below)
- [ ] Block explorer tabs open for all 13 contracts before starting

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

**Expected total time:** 3–7 minutes at normal gas prices (9 transactions).

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
3. Re-run the script — the guard `if (await tge.distributed())` will skip genesis
4. Step 0 will re-confirm allocations, Step 2 will distribute
5. Verify via `verify_tge.js`

---

### Scenario C: Script fails AFTER Step 2 but BEFORE all vaults in Step 3

**Symptom:** `distributed()` = true. Some vaults have `tgeTriggered()` = true,
some still false. Tokens are already in all vault contracts.

**Recovery:**
1. Identify which vaults have NOT been triggered:
```bash
npx hardhat console --network mainnet
> const vault = await ethers.getContractAt("VestingVault", "<VAULT_ADDRESS>")
> await vault.tgeTriggered()   // false = needs manual trigger
```
2. Call `triggerTGE()` on each untriggered vault manually:
```bash
> const tx = await vault.triggerTGE()
> await tx.wait()
> await vault.tgeTriggered()   // must now be true
```
3. Repeat for all untriggered vaults
4. Continue with Step 4 if not yet executed:
```bash
> const staking = await ethers.getContractAt("SRXStaking", process.env.STAKING_MAINNET)
> const bal = await token.balanceOf(process.env.STAKING_MAINNET)
> await staking.notifyRewardAmount(bal)
```
5. Run `verify_tge.js` to confirm full completion

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
- [ ] Activate PreSaleRound: call `presale.openRound()` if public sale follows immediately
- [ ] Deploy GuardianModule (Step 8) if not yet deployed — wires PAUSER_ROLE to SSF
- [ ] Monitor SSF circuit breaker via `scripts/ops/circuit_breaker_monitor.js`
- [ ] Revoke deployer EOA from all remaining roles within 24 hours of TGE

---

## Key Contract Addresses (update when mainnet deployed)

| Contract          | Network | Address |
|-------------------|---------|---------|
| SRXToken          | Sepolia | `0x189352415c8f7165F890B07B3df88EEE289678D3` |
| PreSaleRound      | Sepolia | `0x31cB4Eb87A24E3e677f8B32287056F5a406d4cEe` |
| SRXToken          | Mainnet | TBD |
| TGEDistributor    | Mainnet | TBD |
| All others        | Mainnet | TBD — update after deployment |

---

*Runbook created: 19 May 2026 | SC-005 remediation*
*Review required before mainnet TGE execution*
