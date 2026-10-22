# SRX TOKEN — COMPLETE TECHNICAL OVERVIEW
## Classification: Internal — Confidential
## Version: 1.0 | Written: May 2026
## Author: Syrax Global FZCO — Internal Reference
## Status: Testnet Live (Sepolia) | Awaiting Audit Before Mainnet

---

> **This document is the single source of truth for what the SRX token ecosystem
> is, what it can do, and what it explicitly cannot do.**
> It is derived directly from the smart contract code in this repository (as of the 16 October
> 2026 internal audit; the Sepolia deployment is older, see section 15). Where the contract
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
**fixed-supply ERC-20 token** (a fixed maximum supply of 10 billion SRX; no more can ever be created; buy-and-burn reduces supply) deployed on Ethereum as the canonical
origin chain, with cross-chain representations on BNB Chain, zkSync, and future networks
via LayerZero V2's Omnichain Fungible Token (OFT) standard.

**SRX has three core functions:**

| Function | What It Does |
|----------|-------------|
| **Fee Discount** | Locking SRX in the staking contract reduces payment processing fees on the Syrax gateway — up to 100% reduction at the Obsidian tier. |
| **Governance** | Delegated SRX grants voting power in the SRX DAO. Token holders vote on treasury spending and parameter changes. |
| **Staking Rewards** | Stakers receive SRX rewards from the fixed 1.7 billion SRX staking allocation delivered at launch, in proportion to their stake size and lock duration. Rewards are paid in SRX only. |

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
| **Classification** | SRX is designed as a utility token, not a security. It is built to give access to functions of the Syrax network, and it is designed to confer no ownership, equity, debt or share of profits, and no guaranteed financial return. |
| **Not a dividend-paying instrument** | No SRX holder receives dividends, and holders have no entitlement to Syrax's fee income, present or contingent. Staking rewards are paid in SRX only, from a fixed allocation set at launch — not from fee income. |
| **Not inflationary** | Total supply is fixed at 10,000,000,000 SRX. The genesis mint is one-shot, and permanent reductions happen only through buy-and-burn (and migration, which calls it). The only post-genesis mint is a bridge return on Ethereum, which can restore only SRX the bridge burned there, so total supply on Ethereum never exceeds the cap. ⚠️ Open: internal audit M4 and L9 (design pending): a burn on a spoke chain reduces supply there but is not counted on Ethereum. |
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
Post-genesis minting:           No function creates new supply. The only post-genesis mint
                                is a bridge return on Ethereum, up to what was sent out
Supply reduction:               Only via buyAndBurn() (and ZkSyncMigrator.migrate, which
                                calls it) — permanent, counted in totalBurned
```

**Genuine SRX across all chains is 10,000,000,000 minus `totalBurned`, and never more.**

⚠️ Open: internal audit M4 and L9 (design pending). This holds while nobody burns on a spoke.
A burn on a spoke chain (`SRXOFTNative.buyAndBurn`) reduces real supply, but Ethereum's
`totalBurned` does not change, so anything worked out from "10B minus `totalBurned`" overstates
supply by every spoke burn. The statement stays as the build target.

The `genesis()` function on SRXToken can only be called once (enforced by
`genesisComplete` boolean flag). Once called, the flag is permanently set to `true`
and the function reverts on any future call. A bridge send burns SRX on Ethereum
(this is not a permanent reduction: the SRX is moved to another chain), and a bridge
return mints it back, but only up to what Ethereum sent to that chain and within that
chain's inbound limit. The cap is enforced in `_update`, so Ethereum's `totalSupply`
can never exceed 10 billion. Each remote chain caps its own supply too. A compromised
remote chain can forge SRX on that chain, but it can bring back to Ethereum at most its
inbound limit plus one more limit for each day that passes before the guardian freezes it
(limit × (1 + days of reaction time); after the freeze, nothing:
`test/BridgeConservation.property.test.js`, `test/security-triage-2026-10.test.js`).

---

## 4. Full Allocation Breakdown

The 10 billion SRX is split into the rows of `TGE_PLAN` in `scripts/deploy/00_config.js`,
passed to `TGEDistributor.setAllocations()` by `06_execute_tge.js`. The contract itself holds
no percentages — it **reverts unless the set sums to `MAX_SUPPLY`** (10,000,000,000 SRX). So the
sum is enforced on-chain and the breakdown by the deploy configuration.

**The allocation table, the launch-day float and the release calendar are in
[`docs/TOKENOMICS.md`](docs/TOKENOMICS.md), generated from that configuration by
`scripts/docs/tokenomics.js`.** They are not repeated here, so they cannot drift: a test fails if
the generated file is out of date, and `test/LaunchFloat.test.js` checks the design against the
real contracts.

**The design, in words (28 Sep 2026):**

- **5% of supply is transferable at launch, and nothing else**: the presale's launch tranche, the
  official pool's SRX and the market maker's inventory. Each goes to a multi-signature wallet; the
  deployment refuses a single-key wallet on any real network.
- **No vesting contract releases anything at launch**, founders, core team and seed investors
  included, and nothing new is released for the first 30 days.
- **The liquidity allocation (12%) is split**: the pool and market-maker amounts, and a reserve
  held in a vesting contract for 12 months and then released over 24.
- **The Stabilisation Fund** is held in a governed contract. No single party can deploy it: all
  spending needs a DAO vote through the Timelock, or a declared on-chain stress event with hard
  caps.
- **The staking reward pool** sits in the staking contract and is paid to stakers over time. No
  admin can withdraw it: there is no rescue function (removed 16 Oct 2026, internal audit L1),
  and after wind-down the unused part can only be released to a named successor contract.
- **The Treasury** is spent only through a passed governance vote executed by the Timelock.

⛔ **This section used to say** "12% (Liquidity) is held in a wallet controlled by the liquidity
management multi-sig" and that 53% of supply was vesting-locked. The configuration actually sent
the whole 1.2B liquidity allocation, unlocked, to a single-key wallet, and 25% of the presale also
unlocked at launch: 15.5% in all, and only 49.5% locked. Nothing compared the text with the code.

---

## 5. Contract Suite — What Each Contract Does

There are 16 contracts in the SRX ecosystem (15 in the audit scope, plus the Genesis agreement
registry). Here is what each one does in plain language.

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
- Once `genesis()` is called, no function creates new supply; the only mint is a bridge return, capped at what was sent
- The only way to move tokens cross-chain is through the LayerZero OFT mechanism
- Voting power requires delegation — holding SRX without delegating has zero governance weight
- The pause blocks everything: regular transfers, bridge sends, bridge receives, and burns
  (the one exception is a wound-down staking contract's or fund's own payments, which are
  listed exits)
- It re-credits SRX from another chain only up to what it sent there, and only within that chain's
  inbound limit (`inboundLimit`), a draining bucket: at most the limit is available at any moment, and it
  refills at the limit per 24 hours. With no limit set, it accepts nothing back from that chain, and no
  limit can exceed the 10B cap. A refused return stays retryable in LayerZero. The guardian
  can freeze one chain's returns at once (`GuardianModule.freezeBridgeInbound`), and only governance
  lifts a freeze. This bounds what a compromised chain could return (external disclosure A, 7 Oct 2026)
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

### PreSaleRound.sol — The Seed Investment Contract

Manages the seed round investment process. Investors pay ETH, USDC, USDT, or WBTC,
or are added manually by admin (for off-chain SAFT/wire investors).

**Testnet addresses:** see [`docs/ADDRESSES.md`](docs/ADDRESSES.md), the one generated list.

**What it does:**
- Accepts investment in four currencies: ETH, USDC, USDT, WBTC
- Uses live Chainlink price feeds to calculate ETH and BTC valuations in real-time
- Treats USDC and USDT as $1.00 per whole token (never above par), reading each token's decimals
- Records off-chain investors (SAFT/wire) via `addInvestor()` — no on-chain payment required
- Deploys one VestingVault per investor when admin calls `deployVault()`
- Triggers vesting clocks on all vaults when admin calls `batchTriggerTGE()`
- Allows admin to update or remove investor allocations before their vault is deployed, except for
  an investor who has paid on-chain: they cannot be removed or have their allocation set or reduced
  other than through `refundInvestor()`
- Allows admin to withdraw raised funds (ETH, USDC, USDT, WBTC), except what is owed back in refunds
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
- Cannot mint SRX. It holds only the SRX transferred into it: no allocation in `TGE_PLAN` is
  sent to it. The Genesis round runs on Ethereum only and is funded from the seed allocation (PSR-03, settled)
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
- Allows the admin to revoke unvested tokens (for investors who breach agreements). The launch vaults'
  admin is the SRXTimelock, so governance can revoke one (a public 48-hour proposal); a Genesis buyer's vault
  is revocable by the presale admin. Revoking stops vesting and sends the unvested remainder to the
  vault's `revokeRecipient`, fixed at deployment (the Treasury) and never the beneficiary (internal audit M2).

**Vesting formula:**
```
At TGE:         tgeUnlockBps / 10,000 × totalAllocation (immediately claimable)
During cliff:   0 additional tokens vest (a TGE unlock share, if any, is claimable)
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
  after deployment — all are immutable, as is the revoke recipient. Nobody can accelerate a schedule:
  a revoke pays the unvested part only to the fixed recipient, never the beneficiary (internal audit M2)
- Cannot be triggered for TGE a second time
- Cannot release more than `totalAllocation()` in aggregate
- Cannot be upgraded — each vault is a standalone immutable contract

---

### SRXStaking.sol — The Staking and Fee Discount System (Plain, Non-Upgradeable Contract)

Users lock SRX in this contract to receive fee discounts on the Syrax payment
platform and receive SRX rewards from the fixed 1.7B SRX staking allocation. Rewards are paid in SRX only; no fee revenue, buy-back proceeds or later transfer can extend or pay for them (REG-50).

**What it does in full detail:** — see Section 8.

**Technical notes:**
- A plain contract, deployed directly (REG-53). Its code can never change and no role can upgrade or replace it. Governance (the 48-hour Timelock) can still adjust its parameters: tier thresholds and the reward rate within the fixed allocation. A fix ships as a new contract that holders choose to move to, never forced and never in place (`docs/MIGRATION.md`)
- Irreversible wind-down (exit-only) mode — see "Wind-down" in Section 8
- Synthetix reward-per-token accounting — gas-efficient, correct under concurrent activity
- One position per address — a user cannot have two simultaneous stakes
- 1.7B SRX reward pool is deposited at TGE (capped by the constant `REWARD_ALLOCATION` and by what the launch TGEDistributor recorded delivering); governance controls how fast it is paid out, not how much there is

---

### FeeController.sol — Fee Calculation Engine (Plain, Non-Upgradeable Contract)

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
| Tier | Weighted SRX | Fee Discount |
|------|-----------|-------------|
| None | < 50,000 | 0% |
| Slate | ≥ 50,000 | 25% off base |
| Onyx | ≥ 250,000 | 60% off base |
| Obsidian | ≥ 1,000,000 | 100% off base (the 15 bps fee floor still applies) |

**Example calculations:**
```
Fiat payment, no staking:          1.50%
Fiat payment, Slate tier:         1.50% × (1 - 0.25) = 1.125%
Crypto payment, Onyx tier:       1.125% × (1 - 0.60) = 0.45%
Crypto payment, Obsidian tier:         1.125% × (1 - 1.00) = 0%, raised to the 0.15% floor
SRX payment, any tier:             0% — always
```

**Governance-adjustable parameters:**
- Base fee rate
- Crypto fee multiplier
- Staking contract address
- (Not adjustable: the fee floor, 0.15%, and the cap, 5%, are constants since REG-54)

`GATEWAY_ROLE` is defined on the FeeController but gates no function today: the backend only reads.

---

### SRXTreasury.sol — The DAO Treasury (Plain, Non-Upgradeable Contract)

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
> The `SPENDER_ROLE` is held exclusively by the SRXTimelock contract. (Until the launch
> hand-over the admin also holds `SPENDER_ROLE`; the hand-over revokes that and the role gate
> checks it. The contract is not upgradeable, so its code cannot be swapped.)

**Buy-and-burn process:**
1. Governance passes a proposal authorizing a quarterly buy-and-burn of X SRX
2. Platform revenue (ETH/stablecoins in treasury) is used to purchase SRX on the open market off-chain
3. The purchased SRX is sent to the treasury
4. The Timelock executes `executeBuyAndBurn(amount)` on the treasury
5. The treasury calls `SRXToken.buyAndBurn(amount)` which permanently destroys the tokens
6. `totalBurned` on SRXToken is incremented and the event is permanently on-chain

---

### StabilisationFund.sol — The Syrax Stabilisation Fund / SSF (Plain, Non-Upgradeable Contract)

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
| **1** | `DEPLOYER_ROLE` (treasurer multi-sig) | Active stress event | 30% of free SRX at stress start | Fastest first response |
| **2** | `GUARDIAN_ROLE` (4-of-7 multi-sig: founders + lead investors + DAO delegates) | Active stress event | 70% combined (incl. Tier 1) | Larger intervention without governance vote |
| **3** | `GOVERNANCE_ROLE` (SRXTimelock, 48h delay) | Any time | No percentage cap, but never depositors' principal or the SRX backing rewards | DAO authority over the fund's free assets, any token |

**Critical rule:** Only `GOVERNANCE_ROLE` (SRXTimelock) can resolve a stress event, with one
exception: `startWindDown()` (the Timelock, the Safe through `WIND_DOWN_ROLE`, or anyone after a
30-day pause) ends it for good, one-way, and no new stress event can start afterwards.
GUARDIAN can trigger a stress event, but GUARDIAN cannot close the fast-path window.
This prevents any fast-path actor from independently declaring then resolving stress.

**Stress event lifecycle:**
1. `ORACLE_REPORTER_ROLE` (or `GUARDIAN_ROLE`) calls `triggerStressEvent()`
2. Free SRX (balance less depositors' principal and the SRX that backs rewards) is snapshotted. Fast-path windows open.
3. DEPLOYER deploys SRX to a DEX immediately (up to 30%).
4. If insufficient, GUARDIAN deploys more (up to 70% combined).
5. GOVERNANCE submits a Timelock proposal for anything beyond 70%.
6. When market stabilises, GOVERNANCE calls `resolveStressEvent()`.

**Contributor reward pool (REG-50):**
Any SRX holder may contribute SRX to the fund and receive SRX rewards in proportion to
their contribution. Rewards are paid in SRX only, from a fixed `rewardAllocation` set once
at deployment (size not yet decided; at most the fund's 1.5B launch allocation), and backed
only by launch SRX the TGEDistributor delivered. Platform fees go to the Treasury, never to
the fund: `receiveFees()` was removed. Depositors have no entitlement to Syrax's fee income,
present or contingent. Uses Synthetix reward-per-token accounting. A withdrawal lock (30 days by
default) prevents flash-contribution exploits. Each deposit keeps the lock it was made under:
governance can change the lock only for later deposits, and to at most 90 days. Below a
governance-set minimum total of contributions (`minTotalForEmission`, inactive at 0) emission
does not accrue.

**Wind-down (exit-only) mode (REG-53):**
The fund has an irreversible wind-down mode. `startWindDown()` can be called by the Timelock
(`GOVERNANCE_ROLE`), by the admin Safe (the `WIND_DOWN_ROLE`, which the Safe keeps after the launch
hand-over), or by anyone once the fund has been paused for a total of 30 days within one run of
pauses (pauses less than 7 days apart are one run, and only time actually paused counts). Once on, it
stays on for good: no new contributions, no reward registrations or rate changes, no new stress
events, and emission stops. `exitAfterWindDown()` returns exactly the caller's own principal, with no
penalty and no lock wait, and works while the fund is paused. Rewards accrued up to the switch stay
claimable. No function moves anyone's tokens for them, and governance can still move only the
fund's free SRX, never depositors' principal or the SRX backing rewards. There is no deadline for
these exits once wind-down is on. A token-wide SRXToken pause still stops every transfer, exits
included.

**Reserve layers (target allocations):**
- Stable Reserves (50%): USDC, USDT
- Core Assets (30%): ETH, SRX — TGE seed is initial Core
- Deployed Assets (20%): off-chain DeFi positions reported back; any return on them stays in the fund and is never paid to depositors or holders

**What it cannot do:**
- Fast-path actors (DEPLOYER/GUARDIAN) cannot deploy non-SRX tokens
- DEPLOYER cannot exceed 30% of the free SRX at stress start (contributor principal and the reward pool are never spendable by a fast path)
- No caller, governance included, can deploy depositors' principal or the SRX that backs rewards. `recoverLiquidity()`, which let governance pull tokens from any address that had approved the fund, was removed (finding R7-16)
- GUARDIAN cannot exceed 70% combined in a single stress period
- Nobody can close a stress event without GOVERNANCE_ROLE, except by starting the one-way wind-down
- No SRX can leave the fund without an on-chain event. A deployment (`deployLiquidity`) must carry a reason
  string; contributor withdrawals and reward claims emit events without one

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
| Quorum | 4% of the fixed 10B cap (400M SRX) | For and Abstain votes both count toward quorum; the proposal also needs more For than Against |
| Timelock delay | 48 hours | After a vote passes, 48 hours must elapse before execution |

**What can be put to a vote:**
- Spending from SRXTreasury
- Adjusting fee parameters (FeeController)
- Adjusting staking tier thresholds (SRXStaking)
- Setting ecosystem reward emission rate (SRXStaking)
- Moving to a new version of a contract is a holder's own choice, never forced and never in place (`docs/MIGRATION.md`); no SRX contract can be upgraded
- Changing governor parameters themselves (delay, period, threshold, quorum)
- Setting bridge peers on SRXToken

**What cannot be voted on:**
- Minting more SRX (no function creates new supply; governance cannot add one)
- Changing a vesting vault's schedule (vaults are immutable). Governance can revoke a launch vault,
  which stops vesting; nobody can accelerate one (the unvested part goes only to the recipient fixed
  at deployment, internal audit M2)
- Bypassing the timelock delay (it cannot be set below its deployment value, 48 hours on mainnet)

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
- **DAO milestone:** Timelock becomes fully autonomous (the Safe's own admin rights over the Timelock are already
  removed at the launch hand-over)

---

### SRXOFTNative.sol — Remote Chain Token Representation

The SRX token as it exists on non-Ethereum chains (BNB Chain, zkSync, and future chains).

**What it does:**
- Represents SRX on remote chains via LayerZero V2 burn/mint mechanics
- When a user bridges SRX from Ethereum to BNB Chain: tokens are burned on Ethereum,
  minted on BNB Chain by this contract
- When a user bridges back: tokens are burned on BNB Chain and re-credited on Ethereum, only up to what
  Ethereum sent to that chain and within that chain's inbound limit
- Supports the same `buyAndBurn()` mechanism for burning SRX on remote chains, which reduces supply there
  (⚠️ Open: internal audit M4 and L9, design pending: Ethereum does not count these burns)
- Can be paused to block all remote chain activity (⚠️ Open: internal audit M4, design pending: the spoke
  pause is held by the Safe directly and has none of the hub's time limits)
- Refuses plain transfers to its own address (bridge arrivals are still delivered); its owner, the
  spoke's Timelock, can recover anything stranded there with `rescueTokens`

**What it cannot do:**
- Cannot mint tokens without a verified LayerZero message from its hub
- Cannot accept any peer but the hub, at the address fixed when it was deployed (or zero, to freeze)
- Its owner and LayerZero delegate are that chain's own 48-hour Timelock, so its peers and message
  verification settings change only by a public, delayed proposal; pausing stays immediate
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
- Enforces a cooldown on `pauseModule` (1 hour before the same module can be paused again). `pauseAll`,
  the emergency pause-all, ignores the per-module wait on purpose and has its own 30-minute wait
- Bounds a guardian pause of the token itself: at most 14 days at a time (then anyone may lift it
  with `lapseTokenPause`), a 7-day block after a full term, and 30 days in total. Pauses less than
  7 days apart count as one run of at most 14 days of paused time, so unpausing early and pausing
  again buys nothing. Only governance, by vote, can keep a token pause longer
  (`governanceHoldTokenPause`), and a pause governance holds, or an outside pause that `pauseAll`
  adopted, can be lifted only by governance
- Monitors bridge volume and automatically trips a circuit breaker (a draining bucket) when the threshold is reached;
  a trip stops the bridge only (sends and returns), never ordinary transfers; it lasts until
  governance resets it, and the guardian cannot re-open a tripped module
- Freezes bridge returns from one chain at once (`freezeBridgeInbound`); only governance lifts a freeze
- Signals cross-chain pause intent via events (relayers execute on remote chains)
- Expires permanently after the sunset date, at most 180 days after deployment (enforced in the
  constructor) — guardian powers cannot outlive this date

**Critical property:**
> Governance can always force-unpause anything the guardian has paused.
> The guardian cannot block governance from operating, but it can pause again once its
> cooldown has passed, until the sunset (not a pause that is governance's own, which the guardian
> cannot lift). Unpausing itself has no cooldown.

**What expires at sunset:**
- Guardian's ability to pause modules
- Guardian's ability to trigger the circuit breaker
- Guardian's cross-chain pause signaling

**What does NOT expire at sunset:**
- Anyone's ability to lift a pause the guardian left in place (`releaseAfterSunset`); a pause that is
  governance's own stays governance's to lift
- The contract itself (it remains deployed)
- The circuit breaker reset function (governance still controls this)
- The token-pause lapse: a guardian token pause running at the sunset still ends after its
  14-day term, and anyone may lift it then
- The module registration (governance still manages module addresses)

---

### ZkSyncMigrator.sol — Syrax Chain Migration Contract

When the Syrax Chain launches, SRX holders on EVM chains can burn their tokens here
to receive equivalent native SRX on the Syrax Chain.

**Migration flow:**
1. User approves ZkSyncMigrator to spend their SRX
2. User calls `migrate(amount)` — the migrator pulls the tokens and burns them through `SRXToken.buyAndBurn` (counted in `totalBurned`; not sent to a dead address)
3. A `MigrationRequest` event fires with a migration ID (unique per chain and migrator contract, so consumers key on the emitting address too)
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
- Claim staking rewards (paid in SRX) without unstaking
- Unlock principal after lock period expires
- Exit early (emergency) with a 10% principal penalty

### Presale (if whitelisted as investor)
- Invest with ETH, USDC, USDT, or WBTC during the open round
- Claim vested SRX from their VestingVault after TGE + cliff

### Stabilisation Fund (public contributor pool)
- Contribute SRX to the fund and receive SRX rewards from its fixed reward allocation
- Withdraw contributed SRX after the withdrawal lock set when you deposited (30 days by default)
- Claim accumulated SRX rewards at any time (without withdrawing)
- Contribute USDC/USDT directly to the stable reserves layer

### Migration (when Syrax Chain is live)
- Burn EVM SRX to receive native Syrax Chain SRX via ZkSyncMigrator

---

## 7. What SRX Holders CANNOT Do

These are hard limitations enforced at the smart contract level. No person,
including the founding team, can override these without an exploit.

| Cannot Do | Why |
|-----------|-----|
| Mint new SRX | Genesis is one-shot (`genesisComplete = true` permanently) and no function creates new supply. The only post-genesis mint is a bridge return, capped at what was sent to that chain. |
| Un-burn SRX | Burns via `buyAndBurn()` reduce `totalSupply` permanently. Irreversible. |
| Access treasury funds directly | Treasury requires a Timelock-executed governance vote. No individual can withdraw. |
| Claim more than vested amount | VestingVault's `releasable()` is mathematically capped by time elapsed. |
| Break the vesting cliff | Cliff is fixed at deployment. No linear vesting is claimable during the cliff (the launch vaults have no TGE unlock). |
| Vote without delegating | Undelegated SRX has zero governance weight. Delegation is mandatory. |
| Vote with tokens moved after snapshot | Votes use historical checkpoints at proposal snapshot time. |
| Bypass the Timelock | All governance actions have a mandatory 48-hour delay, and it cannot be set below its deployment value. |
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

| Tier | Minimum Weighted SRX | Fee Discount |
|------|-------------------|-------------|
| None | 0 | 0% |
| Slate | 50,000 | 25% |
| Onyx | 250,000 | 60% |
| Obsidian | 1,000,000 | 100% |

The tier is determined dynamically at payment time from your WEIGHTED stake (principal
times the lock multiplier) while your lock is running, and from your raw principal once
it has expired. So a longer lock needs less principal to reach a tier (for example,
Obsidian needs 1,000,000 SRX at a 7-day lock but 500,000 SRX at a 180-day lock). It is
not the balance at any historical snapshot.

### Staking Rewards

The 1.7 billion SRX reward pool is deposited into the staking contract at TGE.
Governance controls how fast it is paid out via `setRewardRate()`.

**The allocation is fixed (REG-50).** Rewards are paid in SRX only, and only from the SRX that
the launch TGEDistributor recorded delivering to the staking contract, never more than the
constant `REWARD_ALLOCATION` (1.7 billion SRX). No fee revenue, buy-back proceeds or later
transfer can extend or pay for staking rewards. The former second reward stream (a bonus
token such as USDC) was removed from the code entirely. Holders have no entitlement to
Syrax's fee income, present or contingent.

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
The 180-day staker receives twice the rewards per SRX locked.

**Claiming rewards:**
- Rewards can be claimed at any time without unstaking via `claimRewards()`. If the pool ever
  cannot cover what is owed, the unpaid remainder stays claimable (also after exiting)
- Rewards are automatically paid out when `unlock()` or `earlyWithdraw()` is called

### Early Exit

Calling `earlyWithdraw()` before the lock expires:
- Returns `90%` of your principal immediately
- Sends `10%` of your principal to the dead address (out of circulation for good; it is not counted in
  `totalBurned` and does not reduce `totalSupply`)
- Pays out all accrued staking rewards in full (the penalty is on principal only). While the
  contract is paused the principal still leaves, but the rewards stay pending until the pause
  ends (internal audit L11)
- Deletes your position

There is no waiting period or governance approval required for early exit. It is
available even when staking is paused. (If the SRX token itself is paused, the transfer
reverts like every other token movement.)

### Wind-down (exit-only) mode (REG-53)

SRXStaking has an irreversible wind-down mode. `startWindDown()` can be called by the Timelock
(`GOVERNANCE_ROLE`), by the admin Safe (the `WIND_DOWN_ROLE`, which the Safe keeps after the launch
hand-over), or by anyone once the contract has been paused for a total of 30 days within one run of pauses
(`PAUSE_EXIT_DELAY`; pauses less than 7 days apart are one run, and only time actually paused counts). Once on, it stays on
for good:
- No new deposits or locks, no reward registrations or rate changes, and emission stops
- `exitAfterWindDown()` returns exactly the caller's own principal, with no penalty and no lock wait,
  and it works while the contract is paused
- Rewards accrued up to the switch stay claimable, and `claimRewards()` works in wind-down even
  while paused
- No function moves anyone's tokens for them

There is no deadline for these exits once wind-down is on. A token-wide SRXToken pause still stops
every transfer, exits included.

### Adding to a Position

`addToPosition(additionalAmount, newDuration)` allows you to increase your stake:
- Add more SRX to your existing position
- Optionally extend your lock to a longer duration (which upgrades your multiplier)
- You cannot reduce your lock duration or multiplier on an existing position
- If `newDuration = 0`, the position keeps its current duration, and its lock ends no earlier than a
  full term of that duration from now. New SRX always serves a full term (internal audit M5, M6)

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

Each vesting contract's hold period and release period are in
[`docs/TOKENOMICS.md`](docs/TOKENOMICS.md) (the "Schedule" column), generated from `VESTING` in
`scripts/deploy/00_config.js`. `lib/tge_targets.js` checks every deployed vault against that
configuration before any SRX moves.

### Claiming

Beneficiaries call `release()` on their VestingVault to claim available tokens.
They can call this as many times as they want — there are no monthly gate restrictions
in the contract. The UI may present monthly tranches, but the contract pays out
whatever is mathematically vested at the time of the call.

### Revocation

Admin (for Genesis buyer vaults: the PreSaleRound contract, so the presale admin; for the
launch vaults: the SRXTimelock, so a public 48-hour governance proposal) can call `revoke()` on
the vault. This:
1. Pays out all vested-but-unclaimed tokens to the beneficiary immediately
2. Returns all unvested tokens to the `revokeRecipient` (normally the Treasury)
3. Permanently freezes the vault — no future claims are possible

Revocation is only used in cases of investor agreement breach (e.g. failed KYC,
legal dispute). It cannot be used to claw back already-vested tokens.

M2 is fixed (22 Oct 2026): the unvested part goes only to the round's recipient fixed at
deployment (the Treasury), never to the buyer. ⚠️ Open: internal audit M3 (design pending): for a
paying Genesis buyer whose vault already exists, the normal remedy for a failed KYC (a refund) is no
longer available, so a revoke would remove the purchase with no refund.

---

## 10. Governance System — Complete Detail

### How a Proposal Becomes Law

```
Day 0:      Anyone with ≥1,000,000 SRX delegated submits a proposal
Day 1:      Voting delay passes — voting window opens
Day 1-8:    Token holders vote FOR, AGAINST, or ABSTAIN
Day 8:      Voting closes
            — If votes cast (For + Abstain) reach quorum, 4% of the fixed 10B cap (400M SRX),
              AND FOR > AGAINST: proposal PASSES
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
- (The fee floor, 0.15%, and cap, 5%, are fixed in code since REG-54: no role can change them)
- Point to a new staking contract address

**SRXStaking:**
- Change staking tier thresholds (minimum SRX for Slate/Onyx/Obsidian) and the fee discount percentage
  of each tier (thresholds must rise strictly with the tier, Slate must be above 0, and discounts must
  rise with the tier)
- Set the ecosystem reward emission rate
- Register additional reward amounts from the pool
- Start the irreversible wind-down (exit-only) mode (`startWindDown()`)

**SRXGovernor:**
- Change voting delay
- Change voting period
- Change proposal threshold
- Change quorum percentage

**SRXToken:**
- Set LayerZero bridge peer addresses (for adding new chains)
- Set each chain's inbound limit and lift a per-chain freeze (`setInboundLimit`, `unfreezeInbound`)

**GuardianModule:**
- Register new protocol modules
- Configure circuit breaker thresholds
- Reset a tripped circuit breaker (a trip never clears itself)
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
The reverse: SRXOFTNative burns on BNB Chain, and SRXToken re-credits it on Ethereum, but only
up to what Ethereum sent to that chain and within that chain's inbound limit (a draining bucket;
no limit set means no returns). The guardian can freeze one chain's returns; only governance lifts it.

**Supply accounting:**
```
Genuine SRX across all chains = 10,000,000,000 − SRXToken.totalBurned
  held as: SRXToken.totalSupply() [Ethereum]
         + SRXOFTNative.totalSupply() [each remote chain]
         (Ethereum also records outstandingByEid: what it has sent to each chain)
```

⚠️ Open: internal audit M4 and L9 (design pending): this equation holds only while no spoke
burns, see "Buy-and-Burn on Remote Chains" below.

Ethereum's own supply never exceeds 10B (cap in `_update`) and each remote chain caps its
supply too, but the chains do not check each other's totals. A compromised remote chain can
forge SRX on that chain. What protects Ethereum is that returns are bounded by what was sent
there (`outstandingByEid`) and by the per-chain inbound limit, with a guardian freeze. The
conservation property is tested in `test/BridgeConservation.property.test.js` and
`test/security-triage-2026-10.test.js`; the LayerZero message layer itself runs against a mock
endpoint in the test suite, and the required DVN configuration (at least 2) is set by hand and
verified separately.

### Governance Is Ethereum-Only

Voting power is tracked exclusively on Ethereum via `ERC20Votes` delegation.
SRX held on BNB Chain or zkSync has zero governance weight.

Cross-chain governance aggregation (collecting votes from multiple chains) is a
planned Phase 3 feature. Until it is implemented, users who want governance
participation must hold their SRX on Ethereum and delegate.

### Buy-and-Burn on Remote Chains

The `buyAndBurn()` function on `SRXOFTNative` allows the treasury to burn SRX
purchased on non-Ethereum markets. This reduces the supply on that chain without
creating new supply on Ethereum. (Ethereum still counts the SRX it sent to that chain as outstanding,
and `totalBurned` on Ethereum does not change; only Ethereum's own `buyAndBurn` and the migrator add to it.)
⚠️ Open: internal audit M4 and L9 (design pending): until this is decided, the supply statement above
is a build target, not a current guarantee.

---

## 12. Security Architecture

### The Guardian System

GuardianModule holds PAUSER_ROLE on all protocol contracts. It is the emergency
stop mechanism during the protocol's early operation period. ⚠️ Open: internal audit M4 (design
pending): on the spoke chains the admin Safe holds the spoke's `PAUSER_ROLE` directly, not
GuardianModule.

**Guardian sunset:** The guardian's authority expires on a fixed date set at
deployment (at most 180 days after deployment). After that date:
- The guardian cannot pause anything
- All protocol contracts continue to function normally: anyone may lift a pause the guardian
  left in place (`releaseAfterSunset`). A pause that is governance's own (one it holds, an
  outside pause a `pauseAll` adopted, or a tripped breaker) stays until governance lifts it
- Only governance can pause (by passing a proposal)

**Governance always wins over the guardian:**
The guardian can pause. Governance can always unpause. Governance is the 48-hour Timelock
in the deployed topology, so a governance unpause is a Governor proposal and the delay, not
immediate. The guardian cannot block a governance unpause, but it can pause again once its
cooldown has passed, until the sunset. The guardian cannot lift a pause that governance holds.

### Who Controls What (Role Map)

This is the end state after the launch hand-over (`MULTISIG_SPEC.md` is the authority).

```
Gnosis Safe (≥3/5 multi-sig)
  ├── Holds CANCELLER_ROLE on SRXTimelock (a veto: it can cancel, not start)
  ├── Is the guardian: pauses through GuardianModule
  ├── Holds no DEFAULT_ADMIN_ROLE on the core contracts
  ├── Keeps WIND_DOWN_ROLE on SRXStaking and StabilisationFund (can start the irreversible exit-only mode)
  └── Administers the operational contracts (BuybackBurner, SRXAirdrop, PreSaleRound)

SRXTimelock (controlled by SRXGovernor / token holders)
  ├── Holds DEFAULT_ADMIN_ROLE and GOVERNANCE_ROLE on the core contracts
  ├── Holds SPENDER_ROLE on SRXTreasury (the only spender)
  ├── Is admin of the launch VestingVaults and ZkSyncMigrator
  └── Is owner() and LayerZero delegate of SRXToken (and each spoke has its own Timelock)

GuardianModule (controlled by Guardian multi-sig)
  ├── Holds PAUSER_ROLE on SRXToken (pause, and the per-chain inbound freeze)
  ├── Holds PAUSER_ROLE on SRXStaking
  ├── Holds PAUSER_ROLE on SRXTreasury
  ├── Holds PAUSER_ROLE on StabilisationFund
  └── Holds PAUSER_ROLE on FeeController

SRXTreasury, ZkSyncMigrator, BuybackBurner
  └── Hold BURN_ROLE on SRXToken (never the Safe)
```

⚠️ Open: internal audit M4 (design pending): this map is the hub. On each spoke the Safe still holds
`DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `BURN_ROLE` directly.

**No single person can:**
- Spend treasury funds (requires Timelock)
- Pause all protocol contracts (requires Guardian multi-sig)
- Mint new tokens (no function creates new supply; a bridge return is capped at what was sent)
- Upgrade a contract (no SRX contract is upgradeable: there is no upgrade role, and a fix ships as a new contract that holders choose to move to)

---

## 13. Treasury and Buy-and-Burn

### Treasury Holdings

The treasury receives:
- 900,000,000 SRX at TGE (9% of supply) — for operations, grants, ecosystem development
- Platform revenue (ETH, USDC, and other tokens) generated by the Syrax gateway
- Any donations or proceeds received by the DAO

### Buy-and-Burn Mechanics

The buy-and-burn is the supply-reduction mechanism for SRX. It reduces the supply of SRX, and nothing more: it is not a payment to holders.

**Quarterly cycle:**
1. Platform generates fee revenue (ETH/stablecoins)
2. Revenue accumulates in the SRXTreasury
3. Governance votes to authorize a buy-and-burn of a specific amount
4. Off-chain: the authorized amount of revenue is used to purchase SRX on the open market
5. The purchased SRX is sent to the treasury
6. The Timelock executes: `SRXTreasury.executeBuyAndBurn(amount)`
7. The treasury calls `SRXToken.buyAndBurn(amount)`
8. The tokens are permanently destroyed
9. `SRXToken.totalBurned` is incremented
10. `BuyAndBurn` event is emitted — permanently on-chain and publicly verifiable

**What this means for supply:**
Every buy-and-burn reduces `totalSupply` permanently. The tokens cannot be recovered.
The maximum supply is fixed at 10 billion SRX; no more can ever be created, and
buy-and-burn reduces supply.

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

- **Testnet:** the whole suite is deployed on Ethereum Sepolia (the hub), with a spoke on BNB
  Chain testnet. Every address, the deployment date and the deployer are in
  [`docs/ADDRESSES.md`](docs/ADDRESSES.md), generated from the deployment records. No other
  document lists addresses.
- **Mainnet:** ❌ not deployed on any mainnet.

⚠️ The testnet contracts were deployed on 7 October 2026 and predate REG-50, REG-53, REG-54 and the
16 October 2026 internal-audit fixes. They will be redeployed from the fixed code.

**Testnet operation started:** 13 May 2026
**External audit:** Upcoming. SRX will be independently audited before launch
**Mainnet deployment:** After audit completion only

**Deployer wallet:** the testnet deployer is listed in [`docs/ADDRESSES.md`](docs/ADDRESSES.md).
It is for testing only. On mainnet every administrative power is handed to the Timelock and the
Safe before launch, and the deployer key holds no role (`scripts/verify/verify_roles.js`).

---

## 16. What Governance CAN Change

A list of every parameter that SRX token holders can collectively change through
a passed governance vote.

### Fee Parameters (FeeController)
- Base fee rate (currently 1.50%)
- Crypto payment multiplier (currently 75% of base)
- (Not adjustable: the fee floor, 0.15%, and cap, 5%, are constants since REG-54)

### Staking Parameters (SRXStaking)
- Minimum SRX required for Slate tier (currently 50,000)
- Minimum SRX required for Onyx tier (currently 250,000)
- Minimum SRX required for Obsidian tier (currently 1,000,000)
- Fee discount percentage for each tier
- Staking reward emission rate (SRX per second to all stakers, within the fixed allocation)

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
- Module target addresses (when a contract is replaced by a new version that holders move to)
- Guardian sunset date (can only be moved earlier, never later)

### Stabilisation Fund Parameters (StabilisationFund)
- Tier 1 (DEPLOYER_ROLE) cap — default 30% of free SRX at stress start
- Tier 2 (GUARDIAN_ROLE) combined cap — default 70%
- Contributor withdrawal lock duration — default 30 days, at most 90, and it applies only to deposits made afterwards
- Reserve layer target allocations (Stable/Core/Deployed — must sum to 100%)
- Contributor reward emission rate (SRX per second)
- Register reward amounts against the fixed `rewardAllocation` only (nothing else can fund depositor rewards)
- Resolve a declared stress event (only governance can do this; starting the one-way wind-down also ends it for good)
- Deploy the fund's free assets via Timelock proposal (never depositors' principal or the SRX backing rewards)

### Contract Code
None. No SRX contract is upgradeable (REG-53): SRXStaking, FeeController, StabilisationFund and
SRXTreasury are plain contracts deployed directly, and their code can never change. Governance
adjusts their parameters only. A fix ships as a new contract that holders choose to move to
(`docs/MIGRATION.md`).

### Bridge Configuration (SRXToken)
- Peer addresses for new chains (expanding cross-chain support)

---

## 17. What Governance CANNOT Change

These properties are hardcoded in the contracts or architecturally impossible to
change without a completely new deployment.

| Cannot Change | Why |
|--------------|-----|
| Total supply cap (10,000,000,000 SRX) | `MAX_SUPPLY` is a constant. Genesis is one-shot and no function creates new supply. |
| Individual investor vesting schedules | VestingVaults are immutable contracts — deployed with fixed parameters. Nobody can accelerate one: a revoke pays the unvested part only to the recipient fixed at deployment (internal audit M2). |
| The seed round vesting terms | `CLIFF_DURATION` and `VESTING_DURATION` are constants in PreSaleRound. |
| The 10% early exit penalty | `EARLY_WITHDRAW_PENALTY_BPS` is a constant in SRXStaking. |
| The guardian sunset maximum | `MAXIMUM_SUNSET` is immutable — governance can only reduce, never extend. |
| The code of any SRX contract | No SRX contract is upgradeable. SRXStaking, FeeController, StabilisationFund and SRXTreasury are plain contracts (REG-53); every other contract was already non-upgradeable. There is no upgrade role. |
| GuardianModule logic | Not upgradeable. Non-upgradeable by design (an upgradeable guardian could extend its own sunset). |
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
  Quarterly buy-and-burn reduces supply; no more can ever be created
  Multi-chain: Ethereum (origin) + BNB Chain + zkSync + future chains

WHAT IT GIVES YOU:
  Fee discounts on Syrax gateway payments (Obsidian pays only the 0.15% floor on non-SRX payments; SRX payments carry no fee)
  Governance votes on protocol changes and treasury spending
  SRX staking rewards from the fixed 1.7B SRX staking allocation
  Future: native gas on Syrax Chain

WHAT IT DOES NOT GIVE YOU:
  Dividends, profit sharing or any share of Syrax's fee income
  Equity in Syrax Global FZCO
  Guaranteed returns
  Control over treasury without a vote
  Voting power on remote chains (Ethereum only)

THE HARD LIMITS:
  Supply: fixed at 10B — cannot increase
  Vesting: immutable per contract — cannot be accelerated
  Treasury: requires governance — no individual can spend it
  Minting: no new supply after genesis — the only mint is a bridge return, capped at what was sent
  Governance delay: 48 hours minimum — cannot be bypassed

CURRENT STATUS:
  Testnet live on Sepolia since 13 May 2026
  Independent audit upcoming; required before launch
  Gateway (Phase 1) must be live before SRX is accepted for payments
  Syrax Chain (Phase 2) required before native gas and chain migration
```

---

*End of SRX Token Complete Overview*
*Version 1.0 — May 2026*
*This document reflects the contract code at the 16 October 2026 internal audit. The Sepolia deployment (7 Oct 2026) is older and will be redeployed.*
*Update this document whenever contracts are modified or new contracts are added.*
