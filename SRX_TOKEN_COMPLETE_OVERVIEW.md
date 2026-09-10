# SRX TOKEN — COMPLETE TECHNICAL OVERVIEW
## Classification: Internal — Confidential
## Version: 1.0 | Written: May 2026
## Author: Syrax Global FZCO — Internal Reference
## Status: Testnet Live (Sepolia) | Awaiting Audit Before Mainnet

---

> **This document is the single source of truth for what the SRX token ecosystem
> is, what it can do, and what it explicitly cannot do.**
> It is derived directly from the deployed smart contract code. Where the contract
> code and any other document conflict, the contract code is correct.

---

## Table of Contents

1. [What SRX Is](#1-what-srx-is)
2. [What SRX Is Not](#2-what-srx-is-not)
3. [Token Supply — The Hard Numbers](#3-token-supply--the-hard-numbers)
4. [Full Allocation Breakdown](#4-full-allocation-breakdown)
5. [Contract Suite — What Each Contract Does](#5-contract-suite--what-each-contract-does)
6. [What SRX Holders CAN Do](#6-what-srx-holders-can-do)
7. [What SRX Holders CANNOT Do](#7-what-srx-holders-cannot-do)
8. [Staking System — Complete Detail](#8-staking-system--complete-detail)
9. [Vesting System — Complete Detail](#9-vesting-system--complete-detail)
10. [Governance System — Complete Detail](#10-governance-system--complete-detail)
11. [Cross-Chain Architecture](#11-cross-chain-architecture)
12. [Security Architecture](#12-security-architecture)
13. [Treasury and Buy-and-Burn](#13-treasury-and-buy-and-burn)
14. [The Migration Path (Syrax Chain)](#14-the-migration-path-syrax-chain)
15. [Current Deployment State](#15-current-deployment-state)
16. [What Governance CAN Change](#16-what-governance-can-change)
17. [What Governance CANNOT Change](#17-what-governance-cannot-change)

---

## 1. What SRX Is

SRX is the native utility and governance token of the Syrax ecosystem. It is a
**fixed-supply, deflationary ERC-20 token** deployed on Ethereum as the canonical
origin chain, with cross-chain representations on BNB Chain, zkSync, and future networks
via LayerZero V2's Omnichain Fungible Token (OFT) standard.

**SRX has three core functions:**

| Function | What It Does |
|----------|-------------|
| **Fee Discount** | Locking SRX in the staking contract reduces payment processing fees on the Syrax gateway — up to 100% reduction at the Obsidian tier. |
| **Governance** | Delegated SRX grants voting power in the SRX DAO. Token holders vote on treasury spending, protocol upgrades, and parameter changes. |
| **Ecosystem Incentives** | Stakers earn a share of the 1.7 billion SRX ecosystem incentive pool, proportional to their stake size and lock duration. |

**Future functions (Phase 2 — Syrax Chain):**
- Native gas token on the Syrax Chain (ZK Stack Validium architecture)
- Staking participation in network security
- On-chain payment currency accepted by all Syrax gateway merchants

---

## 2. What SRX Is Not

These points are non-negotiable, legally significant, and must never appear otherwise
in any external communication.

| SRX Is NOT | Detail |
|------------|--------|
| **Not a security or investment product** | SRX does not represent equity, debt, or a claim on profits. |
| **Not a dividend-paying instrument** | No SRX holder receives dividends. Staking rewards are ecosystem participation incentives funded from a pre-allocated pool — not generated income. |
| **Not inflationary** | Total supply is fixed at 10,000,000,000 SRX and can only decrease through buy-and-burn. No additional SRX will ever be minted after genesis. |
| **Not a stablecoin** | SRX has no peg mechanism and no backing asset. |
| **Not accepted on the Syrax gateway yet** | SRX payment acceptance is a Phase 2 feature. It is not enabled on the current gateway. |
| **Not a governance token on remote chains** | Governance voting only happens on Ethereum. SRX on BNB Chain and zkSync confers no voting power. |

---

## 3. Token Supply — The Hard Numbers

```
Total Supply (immutable):       10,000,000,000 SRX  (10 billion)
Decimal precision:              18 decimal places
Maximum Supply (on-chain cap):  10,000,000,000 × 10¹⁸ wei — hardcoded in contract
Minting:                        ONE-TIME ONLY — genesis mint to TGEDistributor
Post-genesis minting:           IMPOSSIBLE — no mint function exists after genesis
Supply reduction:               Only via buyAndBurn() — permanent, irreversible
```

**Supply can only go down, never up.**

The `genesis()` function on SRXToken can only be called once (enforced by
`genesisComplete` boolean flag). Once called, the flag is permanently set to `true`
and the function reverts on any future call. There is no other mint function in
the contract.

---

## 4. Full Allocation Breakdown

The 10 billion SRX is split into nine allocation categories. The amounts are the
`ALLOCATIONS` constant in `scripts/deploy/00_config.js`, passed to
`TGEDistributor.setAllocations()` by `06_execute_tge.js`; the contract itself
holds no percentages — it **reverts unless the set sums to `MAX_SUPPLY`**
(10,000,000,000 SRX), which `test/TGE.test.js` covers in both the valid and the
mismatched case. So the sum is enforced on-chain and the breakdown is enforced by
the deploy configuration.

| Category | % | SRX Amount | Destination | Vesting |
|----------|---|-----------|-------------|---------|
| Founders | 10% | 1,000,000,000 | VestingVault | 0% TGE · 365-day cliff · 1095-day linear |
| Core Team | 6% | 600,000,000 | VestingVault | 0% TGE · 182-day cliff · 730-day linear |
| Seed Investors | 4% | 400,000,000 | VestingVault | 0% TGE · 273-day cliff · 730-day linear |
| Presale | 14% | 1,400,000,000 | VestingVault | 25% at TGE · 0-day cliff · 180-day linear |
| Ecosystem DAO | 13% | 1,300,000,000 | VestingVault | 0% TGE · 0-day cliff · 1460-day linear |
| Liquidity | 12% | 1,200,000,000 | Direct wallet | Unlocked at TGE |
| Staking Rewards | 17% | 1,700,000,000 | SRXStaking contract | Distributed to stakers over time |
| Treasury | 9% | 900,000,000 | SRXTreasury contract | Governance-controlled spending |
| Stabilisation Fund (SSF) | 15% | 1,500,000,000 | StabilisationFund contract | Governed deployment — no raw wallet |
| **TOTAL** | **100%** | **10,000,000,000** | | |

**Key observations:**

- **53% of supply** (Founders + Team + Seed + Presale + Ecosystem) is vesting-locked
  and cannot be transferred until vesting conditions are met.
- **15% of supply** (Strategic) is held in the StabilisationFund governed smart
  contract. No single party can deploy it — all spending requires either a DAO
  vote through the Timelock or a declared on-chain stress event with hard BPS caps.
- **12% of supply** (Liquidity) is held in a wallet controlled by the liquidity
  management multi-sig for DEX market-making at TGE.
- **17% of supply** is locked in the staking contract and will be distributed
  to stakers over years — it is not in circulation and cannot be withdrawn by any admin.
- **9% of supply** is in the treasury and can only be spent through a passed governance
  vote executed by the Timelock.

---

## 5. Contract Suite — What Each Contract Does

There are 14 contracts in the SRX ecosystem. Here is what each one does in plain language.

---

### SRXToken.sol — The Token Itself

The main ERC-20 contract. Deployed on Ethereum as the origin chain.

**What it does:**
- Holds the canonical token supply for the entire multi-chain ecosystem
- Enables transfers between addresses on Ethereum
- Enables cross-chain transfers via LayerZero V2 (burn on source, mint on destination)
- Tracks governance voting power via ERC20Votes delegation checkpoints
- Supports gasless approvals via ERC20Permit (EIP-2612)
- Can be paused to block all transfers including bridge transfers
- Tracks total permanently burned tokens in `totalBurned`

**Key design facts:**
- Once `genesis()` is called, no more tokens can ever be minted
- The only way to move tokens cross-chain is through the LayerZero OFT mechanism
- Voting power requires delegation — holding SRX without delegating has zero governance weight
- The pause blocks everything: regular transfers, bridge sends, and bridge receives
- Cross-chain governance (aggregating votes from non-Ethereum chains) is NOT yet implemented

---

### TGEDistributor.sol — The Genesis Launcher

A one-time-use contract that receives all 10 billion SRX from the genesis mint and
distributes them to their correct destinations in a single atomic transaction.

**What it does:**
- Receives 10B SRX from `SRXToken.genesis()`
- Accepts the allocation list from admin (founders vault, team vault, etc.)
- Verifies the sum of allocations equals exactly 10,000,000,000 SRX
- Distributes all tokens in one transaction
- Sets the `distributed` flag permanently after distribution

**What happens after it runs:**
- It holds zero SRX
- It can never distribute again (`distributed = true` blocks re-entry)
- It has an emergency `recoverToken()` for any accidentally sent tokens (admin only,
  only callable after distribution)
- It is functionally dead after the one distribution completes

---

### PreSaleRound.sol — The Seed Investment Contract (LIVE ON SEPOLIA)

Manages the seed round investment process. Investors pay ETH, USDC, USDT, or WBTC,
or are added manually by admin (for off-chain SAFT/wire investors).

**Current testnet addresses:**
- SRXToken (Sepolia): `0x189352415c8f7165F890B07B3df88EEE289678D3`
- PreSaleRound (Sepolia): `0x31cB4Eb87A24E3e677f8B32287056F5a406d4cEe`

**What it does:**
- Accepts investment in four currencies: ETH, USDC, USDT, WBTC
- Uses live Chainlink price feeds to calculate ETH and BTC valuations in real-time
- Treats USDC and USDT as exactly $1.00 each (6-decimal stablecoin)
- Records off-chain investors (SAFT/wire) via `addInvestor()` — no on-chain payment required
- Deploys one VestingVault per investor when admin calls `deployVault()`
- Triggers vesting clocks on all vaults when admin calls `batchTriggerTGE()`
- Allows admin to update or remove investor allocations before their vault is deployed
- Allows admin to withdraw all raised funds (ETH, USDC, USDT, WBTC)
- Can be finalized (closed) to prevent new investments

**Seed round vesting terms (hardcoded in contract — cannot be changed):**
```
TGE Unlock:     0%  — no tokens at launch
Cliff:          273 days (approximately 9 months) — zero tokens vest during this period
Vesting:        730 days (2 years) — linear after cliff
```

**SRX seed price:**
```
$0.0125 per SRX
Stored as: 1,250,000 (in 8-decimal USD format)
ETH and BTC amounts are converted to USD via live Chainlink feeds at time of investment
```

**What it cannot do:**
- Cannot change the vesting terms (cliff and duration are hardcoded constants)
- Cannot accept SOL or XRP on-chain (EVM limitation — use `addInvestor()` for these)
- Cannot mint SRX — it receives SRX from TGEDistributor and holds it
- Cannot accept investment after `finalize()` is called
- Cannot deploy a second vault for the same investor

---

### VestingVault.sol — Individual Investor Vesting Contract

A separate VestingVault is deployed for each investor and each allocation category
(founders, team, seed investors, presale, ecosystem DAO). Each vault holds one
beneficiary's tokens and releases them according to the vesting schedule.

**What it does:**
- Holds tokens for a single beneficiary
- Releases tokens linearly after the TGE unlock and cliff period
- Allows the beneficiary to claim at any point — no monthly gates enforced on-chain
  (monthly tranches are a UI convention, not a contract restriction)
- Allows the admin to revoke unvested tokens (for investors who breach agreements)

**Vesting formula:**
```
At TGE:         tgeUnlockBps / 10,000 × totalAllocation (immediately claimable)
During cliff:   0 additional tokens vest
After cliff:    (elapsed / vestingDuration) × remaining tokens vest linearly
At cliff + vest: 100% of remaining tokens are fully vested
```

**Revocation (admin power):**
When a vault is revoked:
1. All tokens vested but not yet claimed are immediately transferred to the beneficiary
2. All unvested tokens are returned to the `revokeRecipient` (normally the Treasury)
3. After revocation, the vault is permanently frozen — no further claims are possible

**What it cannot do:**
- Cannot change its beneficiary, admin, cliff, vesting duration, or TGE unlock percentage
  after deployment — all are immutable
- Cannot be triggered for TGE a second time
- Cannot release more than `totalAllocation()` in aggregate
- Cannot be upgraded — each vault is a standalone immutable contract

---

### SRXStaking.sol — The Staking and Fee Discount System (UUPS Upgradeable)

Users lock SRX in this contract to receive fee discounts on the Syrax payment
platform and earn ecosystem participation incentives from the 1.7B SRX reward pool.

**What it does in full detail:** — see Section 8.

**Technical notes:**
- UUPS upgradeable — governance can update tier thresholds and reward logic
- Synthetix reward-per-token accounting — gas-efficient, correct under concurrent activity
- One position per address — a user cannot have two simultaneous stakes
- 1.7B SRX reward pool is deposited at TGE and governance controls emission rate

---

### FeeController.sol — Fee Calculation Engine (UUPS Upgradeable)

Calculates the effective payment processing fee for the Syrax gateway. The gateway
backend calls this via `eth_call` (a free read) at payment initiation — no on-chain
transaction is required.

**Fee structure:**

| Payment Type | Base Rate | Staking Discount Applied? |
|-------------|-----------|--------------------------|
| Fiat payment | 1.50% | Yes |
| Crypto (non-SRX) | 1.125% (75% of base) | Yes |
| SRX payment | **0% always** | Not applicable |

**Staking tier discounts on top of payment type base:**
| Tier | SRX Locked | Fee Discount |
|------|-----------|-------------|
| None | < 50,000 | 0% |
| Slate | ≥ 50,000 | 25% off base |
| Onyx | ≥ 250,000 | 60% off base |
| Obsidian | ≥ 1,000,000 | 100% off base (0 fee) |

**Example calculations:**
```
Fiat payment, no staking:          1.50%
Fiat payment, Slate tier:         1.50% × (1 - 0.25) = 1.125%
Crypto payment, Onyx tier:       1.125% × (1 - 0.60) = 0.45%
Crypto payment, Obsidian tier:         1.125% × (1 - 1.00) = 0% (floor may apply)
SRX payment, any tier:             0% — always
```

**Governance-adjustable parameters:**
- Base fee rate
- Crypto fee multiplier
- Minimum fee floor
- Maximum fee cap (currently 5%)
- Staking contract address

---

### SRXTreasury.sol — The DAO Treasury (UUPS Upgradeable)

Holds the 9% treasury allocation (900M SRX) plus any platform revenue converted
to stablecoins or ETH. Controls the quarterly buy-and-burn mechanism.

**What it does:**
- Holds SRX, ETH, USDC, and any other token sent to it
- Executes token transfers only when authorized by the Timelock (passed governance vote)
- Executes the quarterly buy-and-burn on-chain after off-chain market purchase
- Logs every withdrawal with a mandatory reason string for public transparency

**The single most important rule about the treasury:**
> No address — not the admin, not any multi-sig, not any team member — can withdraw
> funds from the treasury without a passed governance vote executed through the Timelock.
> The `SPENDER_ROLE` is held exclusively by the SRXTimelock contract.

**Buy-and-burn process:**
1. Governance passes a proposal authorizing a quarterly buy-and-burn of X SRX
2. Platform revenue (ETH/stablecoins in treasury) is used to purchase SRX on the open market off-chain
3. The purchased SRX is sent to the treasury
4. The Timelock executes `executeBuyAndBurn(amount)` on the treasury
5. The treasury calls `SRXToken.buyAndBurn()` which permanently destroys the tokens
6. `totalBurned` on SRXToken is incremented and the event is permanently on-chain

---

### StabilisationFund.sol — The Syrax Stabilisation Fund / SSF (UUPS Upgradeable)

Holds the 15% Strategic Reserve (1,500,000,000 SRX) in a governed smart contract.
Implements the three-tier emergency response architecture described in the Syrax
Liquidity Resilience Whitepaper. Replaces the original raw strategic wallet.

**Why this contract exists:**
The strategic reserve was always intended to be a market liquidity defence mechanism,
not a simple holding wallet. This contract makes that intent binding on-chain. Every
SRX deployment is logged, capped, and verifiable by any investor or auditor.

**Three-tier deployment authority:**

| Tier | Role | Trigger | Cap | Purpose |
|------|------|---------|-----|---------|
| **1** | `DEPLOYER_ROLE` (treasurer multi-sig) | Active stress event | 30% of SRX at stress start | Fastest first response |
| **2** | `GUARDIAN_ROLE` (4-of-7 multi-sig: founders + lead investors + DAO delegates) | Active stress event | 70% combined (incl. Tier 1) | Larger intervention without governance vote |
| **3** | `GOVERNANCE_ROLE` (SRXTimelock, 48h delay) | Any time | No on-chain cap | Full DAO authority, any token |

**Critical rule:** Only `GOVERNANCE_ROLE` (SRXTimelock) can resolve a stress event.
GUARDIAN can trigger it, but GUARDIAN cannot close the fast-path window.
This prevents any fast-path actor from independently declaring then resolving stress.

**Stress event lifecycle:**
1. `ORACLE_REPORTER_ROLE` (or `GUARDIAN_ROLE`) calls `triggerStressEvent()`
2. SRX balance is snapshotted. Fast-path windows open.
3. DEPLOYER deploys SRX to a DEX immediately (up to 30%).
4. If insufficient, GUARDIAN deploys more (up to 70% combined).
5. GOVERNANCE submits a Timelock proposal for anything beyond 70%.
6. When market stabilises, GOVERNANCE calls `resolveStressEvent()`.

**Contributor reward pool:**
Any SRX holder may contribute to the fund and earn a proportional share of
platform fee income routed on-chain. Uses Synthetix reward-per-token accounting.
A 30-day withdrawal lock prevents flash-contribution exploits.

**Reserve layers (target allocations):**
- Stable Reserves (50%): USDC, USDT
- Core Assets (30%): ETH, SRX — TGE seed is initial Core
- Yield Assets (20%): Off-chain DeFi positions reported back

**What it cannot do:**
- Fast-path actors (DEPLOYER/GUARDIAN) cannot deploy non-SRX tokens
- DEPLOYER cannot exceed 30% of the SRX balance at stress start
- GUARDIAN cannot exceed 70% combined in a single stress period
- Nobody can close a stress event without GOVERNANCE_ROLE
- No SRX can leave without an on-chain event log and reason string

---

### SRXGovernor.sol — On-Chain Governance

The DAO's proposal and voting engine. Allows SRX holders with delegated voting power
to propose, vote on, and execute changes to the protocol.

**Governance parameters:**

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Voting delay | 1 day | After a proposal is created, voting cannot start for 1 day |
| Voting period | 7 days | Votes are open for 7 days |
| Proposal threshold | 1,000,000 SRX | Must hold/be delegated 1M SRX to create a proposal |
| Quorum | 4% | 4% of total supply must vote FOR for the proposal to pass |
| Timelock delay | 48 hours | After a vote passes, 48 hours must elapse before execution |

**What can be put to a vote:**
- Spending from SRXTreasury
- Adjusting fee parameters (FeeController)
- Adjusting staking tier thresholds (SRXStaking)
- Setting ecosystem reward emission rate (SRXStaking)
- Upgrading UUPS proxy contracts (Staking, Treasury, FeeController)
- Changing governor parameters themselves (delay, period, threshold, quorum)
- Setting bridge peers on SRXToken

**What cannot be voted on:**
- Minting more SRX (there is no mint function)
- Changing individual investor vesting schedules (vaults are immutable)
- Bypassing the timelock delay

---

### SRXTimelock.sol — Governance Execution Delay

All passed governance proposals must wait 48 hours in the Timelock before they
can be executed. This gives the community time to review and the guardian the
ability to cancel malicious proposals.

**Roles on the Timelock:**
| Role | Holder | What It Does |
|------|--------|-------------|
| PROPOSER_ROLE | SRXGovernor only | Schedules passed proposals in the queue |
| EXECUTOR_ROLE | address(0) — anyone | Anyone can trigger execution after delay |
| CANCELLER_ROLE | Admin Gnosis Safe | Can cancel a proposal during its delay window |

**Decentralization roadmap:**
- **Now:** 48-hour delay, admin multi-sig holds CANCELLER_ROLE
- **6 months post-TGE:** Delay extended to 72 hours, CANCELLER_ROLE transferred to community security council
- **DAO milestone:** Admin renounces DEFAULT_ADMIN_ROLE — Timelock becomes fully autonomous

---

### SRXOFTNative.sol — Remote Chain Token Representation

The SRX token as it exists on non-Ethereum chains (BNB Chain, zkSync, and future chains).

**What it does:**
- Represents SRX on remote chains via LayerZero V2 burn/mint mechanics
- When a user bridges SRX from Ethereum to BNB Chain: tokens are burned on Ethereum,
  minted on BNB Chain by this contract
- When a user bridges back: tokens are burned on BNB Chain, minted on Ethereum
- Supports the same `buyAndBurn()` mechanism for deflationary burning on remote chains
- Can be paused to block all remote chain activity

**What it cannot do:**
- Cannot mint tokens without a verified LayerZero message from a registered peer
- Cannot track governance voting power (governance is Ethereum-only)
- Cannot initiate a genesis mint — all supply originates from Ethereum
- Has no knowledge of total cross-chain supply — that lives on Ethereum

---

### GuardianModule.sol — Security Emergency System

A standalone security contract with a self-expiring mandate. The guardian (a
security multi-sig) can pause individual modules in an emergency. After the sunset
date, guardian powers expire permanently and cannot be restored.

**What it does:**
- Pauses and unpauses individual protocol modules (token, bridge, staking, fee, treasury)
- Pauses all modules simultaneously in a global emergency
- Enforces cooldown periods to prevent abuse (1 hour between pauses per module)
- Monitors bridge volume and automatically trips a circuit breaker if thresholds are exceeded
- Signals cross-chain pause intent via events (relayers execute on remote chains)
- Expires permanently after the sunset date — guardian powers cannot outlive this date

**Critical property:**
> Governance can always force-unpause anything the guardian has paused.
> The guardian cannot block governance from operating.

**What expires at sunset:**
- Guardian's ability to pause modules
- Guardian's ability to trigger the circuit breaker
- Guardian's cross-chain pause signaling

**What does NOT expire at sunset:**
- The contract itself (it remains deployed)
- The circuit breaker reset function (governance still controls this)
- The module registration (governance still manages module addresses)

---

### ZkSyncMigrator.sol — Syrax Chain Migration Contract

When the Syrax Chain launches, SRX holders on EVM chains can burn their tokens here
to receive equivalent native SRX on the Syrax Chain.

**Migration flow:**
1. User approves ZkSyncMigrator to spend their SRX
2. User calls `migrate(amount)` — tokens are burned to the dead address
3. A `MigrationRequest` event fires with a unique migration ID
4. The Syrax Chain bridge oracle monitors this event
5. The oracle mints equivalent native SRX on the Syrax Chain to the same address
6. Oracle calls `confirmMigration()` on-chain for record-keeping

**What it cannot do:**
- Cannot be used until `enableMigration()` is called by governance
- Cannot be used after `closeMigration()` is called
- Cannot be re-enabled once closed
- Cannot mint SRX — it can only burn existing SRX
- Cannot guarantee migration if the oracle is offline (centralization risk, documented)

---

## 6. What SRX Holders CAN Do

This section describes every action an ordinary SRX holder can take with their tokens.

### Transfer and Approve
- Transfer SRX to any address on Ethereum
- Approve any contract or address to spend SRX on their behalf
- Use `permit()` for gasless approvals (EIP-2612 / ERC20Permit)
- Bridge SRX to BNB Chain or zkSync via LayerZero

### Governance
- Delegate voting power to themselves or any other address
  (`token.delegate(address(self))` — required to activate voting power)
- Delegate to another trusted address to vote on their behalf
- Create a governance proposal (requires 1,000,000 SRX delegated to the proposer's address)
- Vote FOR, AGAINST, or ABSTAIN on any active proposal
- Queue a passed proposal for Timelock execution
- Execute a Timelock-queued proposal after the 48-hour delay has passed

### Staking
- Lock SRX for 7, 30, 90, or 180 days
- Add more SRX to an existing position (optionally extending the lock)
- Claim ecosystem incentive rewards without unstaking
- Unlock principal after lock period expires
- Exit early (emergency) with a 10% principal penalty

### Presale (if whitelisted as investor)
- Invest with ETH, USDC, USDT, or WBTC during the open round
- Claim vested SRX from their VestingVault after TGE + cliff

### Stabilisation Fund (public contributor pool)
- Contribute SRX to the fund and earn a share of platform fee income
- Withdraw contributed SRX after the 30-day lock period
- Claim accumulated rewards at any time (without unstaking)
- Contribute USDC/USDT directly to the stable reserves layer

### Migration (when Syrax Chain is live)
- Burn EVM SRX to receive native Syrax Chain SRX via ZkSyncMigrator

---

## 7. What SRX Holders CANNOT Do

These are hard limitations enforced at the smart contract level. No person,
including the founding team, can override these without an exploit.

| Cannot Do | Why |
|-----------|-----|
| Mint new SRX | No mint function exists after genesis. `genesisComplete = true` permanently. |
| Un-burn SRX | Burns via `buyAndBurn()` reduce `totalSupply` permanently. Irreversible. |
| Access treasury funds directly | Treasury requires a Timelock-executed governance vote. No individual can withdraw. |
| Claim more than vested amount | VestingVault's `releasable()` is mathematically capped by time elapsed. |
| Break the vesting cliff | Cliff is hardcoded. No claim is possible during the cliff period. |
| Vote without delegating | Undelegated SRX has zero governance weight. Delegation is mandatory. |
| Vote with tokens moved after snapshot | Votes use historical checkpoints at proposal snapshot time. |
| Bypass the Timelock | All governance actions have a mandatory 48-hour delay with no bypass. |
| Unstake before lock expires | Normal unlock reverts if `block.timestamp < lockEnd`. |
| Hold two staking positions | The contract enforces one position per address. |
| Receive SRX from a bridge without a verified LZ message | OFT minting is gated by LayerZero's verification layer. |
| Use the migrator before it is enabled | Migration reverts until governance calls `enableMigration()`. |
| Transfer during a pause | `_update()` hook blocks all transfers when `Pausable.paused = true`. |

---

## 8. Staking System — Complete Detail

### Locking Your Tokens

To stake SRX, call `lock(amount, lockDuration)`. There are exactly four valid
lock durations:

| Duration | Constant | Incentive Multiplier |
|----------|----------|---------------------|
| 7 days | LOCK_7D | 1.00× |
| 30 days | LOCK_30D | 1.25× |
| 90 days | LOCK_90D | 1.50× |
| 180 days | LOCK_180D | 2.00× |

No other duration is accepted. Passing any other value reverts with `InvalidLockDuration`.

### Fee Discount Tiers

Fee discounts are applied by the FeeController reading your staked balance on-chain.

| Tier | Minimum Locked SRX | Fee Discount |
|------|-------------------|-------------|
| None | 0 | 0% |
| Slate | 50,000 | 25% |
| Onyx | 250,000 | 60% |
| Obsidian | 1,000,000 | 100% |

The tier is determined dynamically at payment time — it reflects your current
locked balance, not the balance at any historical snapshot.

### Ecosystem Incentive Rewards

The 1.7 billion SRX reward pool is deposited into the staking contract at TGE.
Governance controls the emission rate via `setRewardRate()`.

**How rewards accumulate:**
```
Your reward share = Your weighted stake / Total weighted stake × Reward rate per second
```

Where your weighted stake is:
```
Weighted stake = amount_locked × multiplier / 100
```

So a user with 100,000 SRX locked for 180 days has:
```
Weighted stake = 100,000 × 200 / 100 = 200,000
```
...compared to a user with 100,000 SRX locked for 7 days who has:
```
Weighted stake = 100,000 × 100 / 100 = 100,000
```
The 180-day staker earns twice the rewards per SRX locked.

**Claiming rewards:**
- Rewards can be claimed at any time without unstaking via `claimRewards()`
- Rewards are automatically paid out when `unlock()` or `earlyWithdraw()` is called

### Early Exit

Calling `earlyWithdraw()` before the lock expires:
- Returns `90%` of your principal immediately
- Burns `10%` of your principal permanently to the dead address (gone forever)
- Pays out all earned incentive rewards in full (the penalty is on principal only)
- Deletes your position

There is no waiting period or governance approval required for early exit. It is
always available, even when staking is paused.

### Adding to a Position

`addToPosition(additionalAmount, newDuration)` allows you to increase your stake:
- Add more SRX to your existing position
- Optionally extend your lock to a longer duration (which upgrades your multiplier)
- You cannot reduce your lock duration or multiplier on an existing position
- If `newDuration = 0`, only the additional amount is added with no lock extension

### One Position Per Address

A single address can only hold one staking position. To open a new position with
different parameters, you must first exit (via `unlock()` or `earlyWithdraw()`).

---

## 9. Vesting System — Complete Detail

### How Vesting Works

Each allocation category has its own VestingVault deployed at TGE. Vesting follows
this universal formula:

```
Phase 1 — TGE Unlock:
  Immediately claimable = totalAllocation × tgeUnlockBps / 10,000

Phase 2 — Cliff Period:
  Duration: cliffDuration seconds from TGE
  Nothing additional vests during this period

Phase 3 — Linear Vesting:
  Each second after the cliff, the following additional amount becomes claimable:
  (totalAllocation - tgeAmount) / vestingDuration × (seconds elapsed since cliff)

Phase 4 — Fully Vested:
  Once (cliff + vestingDuration) has elapsed, 100% of totalAllocation is claimable
```

### Vesting Parameters by Category

| Category | TGE Unlock | Cliff | Linear Vest | Total Duration |
|----------|-----------|-------|-------------|----------------|
| Founders | 0% | 365 days | 1,095 days | ~4 years total |
| Core Team | 0% | 182 days | 730 days | ~2.5 years total |
| Seed Investors | 0% | 273 days | 730 days | ~2.75 years total |
| Presale | 25% | 0 days | 180 days | 6 months for remainder |
| Ecosystem DAO | 0% | 0 days | 1,460 days | 4 years total |

### Claiming

Beneficiaries call `release()` on their VestingVault to claim available tokens.
They can call this as many times as they want — there are no monthly gate restrictions
in the contract. The UI may present monthly tranches, but the contract pays out
whatever is mathematically vested at the time of the call.

### Revocation

Admin (for presale vaults: the PreSaleRound contract; for other categories: the
deployer multi-sig) can call `revoke()` on any vault. This:
1. Pays out all vested-but-unclaimed tokens to the beneficiary immediately
2. Returns all unvested tokens to the `revokeRecipient` (normally the Treasury)
3. Permanently freezes the vault — no future claims are possible

Revocation is only used in cases of investor agreement breach (e.g. failed KYC,
legal dispute). It cannot be used to claw back already-vested tokens.

---

## 10. Governance System — Complete Detail

### How a Proposal Becomes Law

```
Day 0:      Anyone with ≥1,000,000 SRX delegated submits a proposal
Day 1:      Voting delay passes — voting window opens
Day 1-8:    Token holders vote FOR, AGAINST, or ABSTAIN
Day 8:      Voting closes
            — If FOR votes ≥ 4% of total supply AND FOR > AGAINST: proposal PASSES
            — Otherwise: proposal DEFEATED (no further action)
Day 8:      Passed proposal is queued in the Timelock (48-hour delay begins)
Day 10:     After 48-hour delay: anyone can call execute() to implement the proposal
```

### What Governance Can Actually Change

Via the Timelock, a passed vote can instruct contracts to do the following:

**Treasury:**
- Transfer any ERC-20 token or ETH to any address (with a mandatory reason string)
- Execute buy-and-burn of a specific SRX amount

**FeeController:**
- Change the base fee rate
- Change the crypto payment multiplier
- Set fee floor and cap
- Point to a new staking contract address
- Upgrade the FeeController implementation (UUPS)

**SRXStaking:**
- Change staking tier thresholds (minimum SRX for Slate/Onyx/Obsidian)
- Change fee discount percentages for each tier
- Set the ecosystem reward emission rate
- Register additional reward amounts from the pool
- Upgrade the staking implementation (UUPS)

**SRXGovernor:**
- Change voting delay
- Change voting period
- Change proposal threshold
- Change quorum percentage

**SRXToken:**
- Set LayerZero bridge peer addresses (for adding new chains)

**GuardianModule:**
- Register new protocol modules
- Configure circuit breaker thresholds
- Reset a tripped circuit breaker
- Force-unpause any module the guardian has paused
- Reduce the guardian sunset date (bring expiry forward)

---

## 11. Cross-Chain Architecture

### How Cross-Chain SRX Works

SRX uses LayerZero V2's Omnichain Fungible Token (OFT) standard.

**Bridging Ethereum → BNB Chain:**
1. User initiates bridge on Ethereum
2. SRXToken's OFT logic burns the SRX on Ethereum
3. LayerZero V2 sends a verified message to the BNB Chain endpoint
4. SRXOFTNative on BNB Chain receives the message and mints the equivalent SRX
5. The user now holds SRX on BNB Chain

**Bridging BNB Chain → Ethereum:**
The reverse: SRXOFTNative burns on BNB Chain, SRXToken mints on Ethereum.

**Supply accounting:**
```
Total SRX in existence at any moment =
  SRXToken.totalSupply() [on Ethereum]
  + SRXOFTNative.totalSupply() [on BNB Chain]
  + SRXOFTNative.totalSupply() [on zkSync]
  + (any future remote chains)
  = Always ≤ 10,000,000,000 SRX
```

The LayerZero protocol guarantees that a burn on one chain always equals a mint on
the receiving chain. No new tokens are created — they are relocated.

### Governance Is Ethereum-Only

Voting power is tracked exclusively on Ethereum via `ERC20Votes` delegation.
SRX held on BNB Chain or zkSync has zero governance weight.

Cross-chain governance aggregation (collecting votes from multiple chains) is a
planned Phase 3 feature. Until it is implemented, users who want governance
participation must hold their SRX on Ethereum and delegate.

### Buy-and-Burn on Remote Chains

The `buyAndBurn()` function on `SRXOFTNative` allows the treasury to burn SRX
purchased on non-Ethereum markets. This reduces the supply on that chain without
creating new supply on Ethereum — a deflationary mechanism that works on every chain.

---

## 12. Security Architecture

### The Guardian System

GuardianModule holds PAUSER_ROLE on all protocol contracts. It is the emergency
stop mechanism during the protocol's early operation period.

**Guardian sunset:** The guardian's authority expires on a fixed date set at
deployment (typically 6-12 months post-TGE). After that date:
- The guardian cannot pause anything
- All protocol contracts continue to function normally
- Only governance can pause (by upgrading contracts or passing an emergency proposal)

**Governance always wins over the guardian:**
The guardian can pause. Governance can always unpause, immediately, without delay.
The guardian cannot block a governance unpause.

### Who Controls What (Role Map)

```
Gnosis Safe (≥3/5 multi-sig)
  ├── Holds DEFAULT_ADMIN_ROLE on SRXToken
  ├── Holds CANCELLER_ROLE on SRXTimelock
  └── Holds DEFAULT_ADMIN_ROLE on GuardianModule

SRXTimelock (controlled by SRXGovernor / token holders)
  ├── Holds SPENDER_ROLE on SRXTreasury (the only spender)
  ├── Holds GOVERNANCE_ROLE on SRXStaking
  ├── Holds GOVERNANCE_ROLE on FeeController
  └── Holds GOVERNANCE_ROLE on GuardianModule

GuardianModule (controlled by Guardian multi-sig)
  ├── Holds PAUSER_ROLE on SRXToken
  ├── Holds PAUSER_ROLE on SRXStaking
  ├── Holds PAUSER_ROLE on SRXTreasury
  └── Holds PAUSER_ROLE on FeeController

SRXTreasury
  └── Holds BURN_ROLE on SRXToken (for buy-and-burn)
```

**No single person can:**
- Spend treasury funds (requires Timelock)
- Pause all protocol contracts (requires Guardian multi-sig)
- Mint new tokens (impossible — no function exists)
- Upgrade a contract (requires GOVERNANCE_ROLE = Timelock = passed vote)

---

## 13. Treasury and Buy-and-Burn

### Treasury Holdings

The treasury receives:
- 900,000,000 SRX at TGE (9% of supply) — for operations, grants, ecosystem development
- Platform revenue (ETH, USDC, and other tokens) generated by the Syrax gateway
- Any donations or proceeds received by the DAO

### Buy-and-Burn Mechanics

The buy-and-burn is the deflationary mechanism for SRX.

**Quarterly cycle:**
1. Platform generates fee revenue (ETH/stablecoins)
2. Revenue accumulates in the SRXTreasury
3. Governance votes to authorize a buy-and-burn of a specific amount
4. Off-chain: the authorized amount of revenue is used to purchase SRX on the open market
5. The purchased SRX is sent to the treasury
6. The Timelock executes: `SRXTreasury.executeBuyAndBurn(amount)`
7. The treasury calls `SRXToken.buyAndBurn(treasury_address, amount)`
8. The tokens are permanently destroyed
9. `SRXToken.totalBurned` is incremented
10. `BuyAndBurn` event is emitted — permanently on-chain and publicly verifiable

**What this means for supply:**
Every buy-and-burn reduces `totalSupply` permanently. The tokens cannot be recovered.
Over time, increasing platform revenue drives increasing quarterly burns, creating
a deflationary relationship between platform growth and token supply.

---

## 14. The Migration Path (Syrax Chain)

When the Syrax Chain launches, SRX evolves from an EVM token to the native gas
and governance asset of a custom ZK Validium chain.

### How Migration Works

Users who want to participate on the Syrax Chain:
1. Approve ZkSyncMigrator to spend their SRX
2. Call `migrate(amount)` — this burns the SRX permanently on the EVM chain
3. Receive equivalent native SRX on the Syrax Chain at the same address

**This is voluntary.** Users who prefer to stay on Ethereum or BNB Chain can
continue to hold and use SRX on those chains. The OFT bridge continues to operate.

**Users who do not migrate:**
- Continue to hold SRX on Ethereum/BNB Chain as normal ERC-20 tokens
- Continue to have governance voting power (Ethereum only)
- Can bridge between EVM chains normally
- Can migrate to the Syrax Chain at any time during the open migration window
- After the migration window closes, a governance-controlled snapshot fallback
  is the only recourse for users who missed the window

### Migration Window

- Opens when governance calls `enableMigration()` (only after Syrax Chain is live)
- Closes permanently when governance calls `closeMigration()` (cannot be reversed)
- The window duration is determined by governance

---

## 15. Current Deployment State

**As of May 2026:**

| Contract | Network | Status | Address |
|----------|---------|--------|---------|
| SRXToken | Sepolia | ✅ Deployed & Verified | `0x189352415c8f7165F890B07B3df88EEE289678D3` |
| PreSaleRound | Sepolia | ✅ Deployed & Verified | `0x31cB4Eb87A24E3e677f8B32287056F5a406d4cEe` |
| All other contracts | — | Not yet deployed to testnet | Pending |
| All contracts | Mainnet | ❌ Not deployed | Awaiting audit |

**Testnet operation started:** 13 May 2026
**Minimum testnet period:** 2 weeks (ends approximately 27 May 2026)
**External audit:** Required before mainnet — Halborn or equivalent Tier 1 firm
**Mainnet deployment:** After audit completion only

**Deployer wallet (Sepolia test only — NOT for mainnet):**
`0x049fea6abBbc88487Ca14A7910d37E1feCdb9236`

This wallet is for testing only. The mainnet deployer must be a Gnosis Safe.

---

## 16. What Governance CAN Change

A list of every parameter that SRX token holders can collectively change through
a passed governance vote.

### Fee Parameters (FeeController)
- Base fee rate (currently 1.50%)
- Crypto payment multiplier (currently 75% of base)
- Minimum fee floor (currently 0%)
- Maximum fee cap (currently 5%)

### Staking Parameters (SRXStaking)
- Minimum SRX required for Slate tier (currently 50,000)
- Minimum SRX required for Onyx tier (currently 250,000)
- Minimum SRX required for Obsidian tier (currently 1,000,000)
- Fee discount percentage for each tier
- Ecosystem reward emission rate (SRX per second to all stakers)

### Governance Parameters (SRXGovernor)
- Voting delay (currently 1 day)
- Voting period (currently 7 days)
- Proposal threshold (currently 1,000,000 SRX)
- Quorum fraction (currently 4%)

### Treasury Actions (SRXTreasury)
- Any ERC-20 transfer from the treasury (with reason)
- Any ETH transfer from the treasury (with reason)
- Buy-and-burn execution (amount and timing)

### Security Parameters (GuardianModule)
- Circuit breaker thresholds and windows
- Module target addresses (after UUPS upgrades)
- Guardian sunset date (can only be moved earlier, never later)

### Stabilisation Fund Parameters (StabilisationFund)
- Tier 1 (DEPLOYER_ROLE) cap — default 30% of SRX balance at stress start
- Tier 2 (GUARDIAN_ROLE) combined cap — default 70%
- Contributor withdrawal lock duration — default 30 days
- Reserve layer target allocations (Stable/Core/Yield — must sum to 100%)
- Contributor reward emission rate (SRX per second)
- Register new reward amounts from fee income into the contributor pool
- Resolve a declared stress event (only governance can do this)
- Deploy capital without restriction at any time via Timelock proposal

### Contract Upgrades (UUPS)
- New implementation for SRXStaking
- New implementation for FeeController
- New implementation for SRXTreasury
- New implementation for StabilisationFund

### Bridge Configuration (SRXToken)
- Peer addresses for new chains (expanding cross-chain support)

---

## 17. What Governance CANNOT Change

These properties are hardcoded in the contracts or architecturally impossible to
change without a completely new deployment.

| Cannot Change | Why |
|--------------|-----|
| Total supply cap (10,000,000,000 SRX) | `MAX_SUPPLY` is a constant. No mint function exists after genesis. |
| Individual investor vesting schedules | VestingVaults are immutable contracts — deployed with fixed parameters. |
| The seed round vesting terms | `CLIFF_DURATION` and `VESTING_DURATION` are constants in PreSaleRound. |
| The 10% early exit penalty | `EARLY_WITHDRAW_PENALTY_BPS` is a constant in SRXStaking. |
| The guardian sunset maximum | `MAXIMUM_SUNSET` is immutable — governance can only reduce, never extend. |
| SRXGovernor or SRXTimelock logic | These contracts are not UUPS upgradeable. |
| GuardianModule logic | Not upgradeable. Non-upgradeable by design (a UUPS guardian could extend its own sunset). |
| VestingVault logic for deployed vaults | Each vault is a standalone immutable contract. |
| The genesis distribution | `TGEDistributor.distributed = true` is permanent after distribution. |
| Burn reversals | No un-burn mechanism exists anywhere in the suite. |
| Governance votes already executed | Timelock execution is final. |

---

## Summary: SRX in One Page

```
WHAT SRX IS:
  Fixed-supply utility + governance token
  10,000,000,000 SRX — no more, ever
  Deflationary via quarterly buy-and-burn
  Multi-chain: Ethereum (origin) + BNB Chain + zkSync + future chains

WHAT IT GIVES YOU:
  Fee discounts on Syrax gateway payments (0% fees at Obsidian tier)
  Governance votes on protocol changes and treasury spending
  Ecosystem incentive rewards from the 1.7B SRX staking pool
  Future: native gas on Syrax Chain

WHAT IT DOES NOT GIVE YOU:
  Dividends or profit sharing
  Equity in Syrax Global FZCO
  Guaranteed returns
  Control over treasury without a vote
  Voting power on remote chains (Ethereum only)

THE HARD LIMITS:
  Supply: fixed at 10B — cannot increase
  Vesting: immutable per contract — cannot be accelerated
  Treasury: requires governance — no individual can spend it
  Minting: impossible after genesis — no function exists
  Governance delay: 48 hours minimum — cannot be bypassed

CURRENT STATUS:
  Testnet live on Sepolia since 13 May 2026
  Full audit required before mainnet
  Gateway (Phase 1) must be live before SRX is accepted for payments
  Syrax Chain (Phase 2) required before native gas and chain migration
```

---

*End of SRX Token Complete Overview*
*Version 1.0 — May 2026*
*This document reflects the contract code as deployed on Sepolia testnet.*
*Update this document whenever contracts are modified or new contracts are added.*
