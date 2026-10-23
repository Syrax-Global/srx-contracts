# SRX Staking — Platform Overview

**Contract:** `SRXStaking.sol` (a plain contract deployed directly: not a proxy, not upgradeable; REG-53)  
**Reward pool:** 1,700,000,000 SRX (allocated at TGE, held in contract)  
**Last updated:** 16 Oct 2026 (REG-50, REG-53, internal audit)

---

## Core Concept

Staking does two things simultaneously:

1. **Pays rewards in SRX** to stakers, from the fixed 1.7B SRX staking allocation delivered at launch. Rewards are paid in SRX only, and nothing else can extend or pay for them
2. **Gives merchants and users fee discounts** on gateway transactions based on how much they stake

---

## 1. Locking — How to Enter

Call `lock(amount, duration)` to open a position. One position per wallet.

The **lock duration** determines a multiplier that scales your reward share, and also counts toward your tier while the lock is running (section 2):

| Duration | Multiplier | weightedAmount (on 1M SRX) |
|---|---|---|
| 7 days | 1.0× | 1,000,000 SRX |
| 30 days | 1.25× | 1,250,000 SRX |
| 90 days | 1.5× | 1,500,000 SRX |
| 180 days | 2.0× | 2,000,000 SRX |

The **weighted amount** is what determines your share of the reward pool — not the raw SRX locked. A 180-day staker receives 2× the rewards of a 7-day staker for the same principal. The weighted amount also sets your tier while the lock is running.

---

## 2. Tiers — Fee Discount on Gateway

Tiers are determined by your **weighted stake** (principal times the lock multiplier) while the lock is running, and by your raw principal once the lock has expired. So a longer lock needs less principal to reach a tier: Obsidian needs 1,000,000 SRX at a 7-day lock but 500,000 SRX at a 180-day lock. Changing the tier thresholds (`updateTierParams`) applies to existing positions at once. Governance cannot set them in a way that gives everyone a discount: Slate must stay above 0, thresholds must rise strictly with the tier, and discounts must rise with the tier (internal audit L12). After wind-down a position counts its principal only (L13).

| Tier | Minimum weighted stake | Fee discount (fiat/crypto) | SRX payment discount |
|---|---|---|---|
| None | < 50,000 SRX | 0% | 100% (always) |
| Slate | ≥ 50,000 SRX | 25% | 100% (always) |
| Onyx | ≥ 250,000 SRX | 60% | 100% (always) |
| Obsidian | ≥ 1,000,000 SRX | 100% | 100% (always) |

SRX payment type always carries a 100% discount regardless of staking tier — this is hardcoded in FeeController, not staking-dependent.

Obsidian-tier merchants get the full discount, but a **15 bps (0.15%) fee floor still applies on non-SRX transactions** (FeeController `MIN_FEE_BPS`, fixed in code since REG-54); SRX payments carry no fee at any tier. This is the primary commercial incentive for large merchants to stake SRX.

---

## 3. Adding to a Position — `addToPosition(amount, newDuration)`

You can add SRX to your existing position at any time (on an expired lock, the new SRX starts a fresh lock):

- **Tier upgrades automatically** as you cross Slate/Onyx/Obsidian thresholds
- **Duration can only extend**, never shorten — pass `0` to keep the current duration. The lock then ends no earlier than a full term of that duration from now, so new SRX always serves a full term (internal audit M5, M6)
- **weightedAmount** is recalculated on the full position if duration is extended
- **Accrued rewards are auto-checkpointed** before the position is modified — accrued rewards are never lost

Example (confirmed on testnet):
- Lock 50,000 SRX @ 7d → Slate, weightedAmount = 50,000
- Add 200,000 SRX → Onyx, weightedAmount = 250,000 (still 7d multiplier)
- Add 750,000 SRX, extend to 30d → Obsidian, weightedAmount = 1,250,000 (1.25× on full 1M)

---

## 4. Reward Mechanics

The contract uses the **Synthetix staking reward model**:

- A global `rewardPerTokenStored` accumulator grows continuously as long as `rewardRate > 0` and weighted stake > 0
- Each staker tracks `userRewardPerTokenPaid` — a snapshot of the accumulator at their last interaction
- `earned(wallet)` (the SRX accrued so far) = `(rewardPerTokenStored − userRewardPerTokenPaid) × weightedAmount ÷ 1e18`

**Governance controls the rate.** `setRewardRate(amount)` is GOVERNANCE_ROLE only and flows through the Timelock. The launch rate is set once at TGE, by the launch multisig while it still holds GOVERNANCE_ROLE, from the published schedule (13.5 SRX/s, about four years for the 1.7B pool), because voting starts only once holders have delegated enough SRX to reach quorum. After the role hand-over the rate can be adjusted up or down only by governance vote — this sets how fast the fixed allocation is paid out, not how much there is, and the period ends when the pool runs out.

The 1.7B SRX reward pool is designed to last for many years. The exact rate at mainnet will be set by the founding governance vote after token launch.

**The allocation is fixed (REG-50).** Rewards can only be registered against the SRX that the launch `TGEDistributor` recorded delivering to this contract, and never more than the constant `REWARD_ALLOCATION` (1.7B SRX). SRX that arrives any other way (fee revenue, buy-back proceeds or a plain transfer) cannot extend the rewards or pay for them, whoever holds `GOVERNANCE_ROLE`.

**Testnet verification:**
- Rate set to 500 SRX/s (accelerated for testnet)
- Obsidian staker (1.25M weighted) accrued ~6,000 SRX per 12-second block
- Production rate will be orders of magnitude lower

---

## 5. Claiming and Exiting

### `claimRewards()` — claim without unstaking
- Transfers all `earned()` SRX to the staker
- Position remains active — lock continues, weighted amount unchanged while the lock runs. On an expired lock, claiming first drops the weight to 1.0× (the multiplier ends with the lock), as `unlock` and `earlyWithdraw` do
- Works without a live position too: rewards still owed (for example an unpaid remainder after a pool shortfall) stay claimable after exiting
- `userRewardPerTokenPaid` is reset to current accumulator

### `unlock()` — clean exit after lock expires
- Only callable after `lockEnd` timestamp
- Returns 100% of principal to staker
- Any unclaimed rewards are auto-paid
- Position is deleted

### `earlyWithdraw()` — exit before lock expires
- **10% of principal** sent to `0x000000000000000000000000000000000000dEaD` (out of circulation for good; not counted in `SRXToken.totalBurned`)
- **90% of principal** returned to staker's wallet
- Any earned rewards are paid in full (no penalty on rewards, only on principal). While the contract is paused the principal still leaves, but the rewards stay pending until the pause ends (internal audit L11)
- Position is deleted

**Testnet confirmation:**
- 1,000,000 SRX staked → 100,000 SRX sent to the dead address, 906,000 returned (900K principal + 6K residual rewards)
- Dead address balance increase verified on-chain

### `exitAfterWindDown()` — exit once wind-down (exit-only mode) is on
SRXStaking has an irreversible wind-down mode (REG-53). Once `startWindDown()` has been called:
- No new deposits or locks, no reward registrations or rate changes, and emission stops
- `exitAfterWindDown()` returns exactly the caller's own principal, with no penalty and no lock wait, and it works while the contract is paused
- Rewards accrued up to the switch stay claimable, and `claimRewards()` works in wind-down even while paused
- No function moves anyone's tokens for them
- There is no deadline for these exits once wind-down is on. A token-wide `SRXToken` pause still stops every transfer, exits included
- Who can start it: the Timelock (`GOVERNANCE_ROLE`), the admin Safe (`WIND_DOWN_ROLE`), or anyone once the contract has been paused for a total of 30 days within one run of pauses (`PAUSE_EXIT_DELAY`; pauses less than 7 days apart, `PAUSE_BREAK`, are one run, and only time actually paused counts). It cannot be switched off again

---

## 6. Second Reward Stream — Removed by Design (REG-50)

An earlier version of the contract had a second reward stream for a bonus ERC-20 token (intended to be USDC, funded from platform fee revenue). It was **removed from the code entirely on 11–12 Oct 2026** under decision REG-50. The functions `setBonusRewardToken`, `notifyBonusRewardAmount`, `setBonusRewardRate`, `claimBonusRewards`, `earnedBonus` and `rescueStrandedBonusPool` no longer exist.

**Why:** holders have no entitlement to Syrax's fee income, present or contingent. A feature that was switched off but could be switched on by a governance vote was still a path to that entitlement, so it was deleted rather than left dormant.

**What remains:**
- Staking rewards are paid in SRX only, from the fixed 1.7B SRX staking allocation delivered at launch.
- Fee discounts for stakers (25% / 60% / 100%, with a 15 bps floor) are unchanged. They are a discount on fees the staker pays, not income.
- No fee revenue, buy-back proceeds or later transfer can extend or pay for staking rewards.

---

## 7. FeeController Integration

The staking contract does not collect fees. `FeeController` does. When the gateway charges a user:

1. `FeeController.calculateFee(userWallet, paymentType)` is called
2. FeeController reads `SRXStaking.getTier(userWallet)` — live, on every call
3. The appropriate discount is applied from the tier lookup
4. For `PaymentType.SRX` — always returns 0, hardcoded regardless of tier

The fee routing table (up to 8 destinations: Treasury, AutoBurn, etc.) is configured via `setFeeDestination()` and committed via `commitFeeDistribution()` — governance-controlled; the contract's code is never touched. Platform fees go to the Treasury (or the buy-back); a destination pointed at the staking contract or the Stabilisation Fund cannot become rewards.

---

## 8. Key State Variables (for reference)

| Variable | Type | Description |
|---|---|---|
| `positions[addr]` | `StakePosition` | amount, lockEnd, lockedAt, lockDuration, weightedAmount |
| `rewardPool` | uint256 | SRX in the reward pool (at most the 1.7B fixed allocation) |
| `rewardRate` | uint256 | SRX per second emitted to stakers |
| `rewardPerTokenStored` | uint256 | Global accumulator (Synthetix pattern) |
| `totalWeightedStake` | uint256 | Sum of all stakers' weighted amounts |
| `rewardBacking` | uint256 | SRX the launch TGEDistributor delivered here (at most `REWARD_ALLOCATION`); the ceiling on all rewards |

---

## 9. Roles

| Role | Who holds it | What they can do |
|---|---|---|
| `GOVERNANCE_ROLE` | SRXTimelock | `setRewardRate`, `notifyRewardAmount` (capped by the fixed allocation), `updateTierParams` |
| `PAUSER_ROLE` | GuardianModule | `pause()` / `unpause()` |
| `WIND_DOWN_ROLE` | The admin Safe (kept after the launch hand-over; never the deployer) | `startWindDown()`: the irreversible exit-only mode. It cannot move anyone's tokens |
| `DEFAULT_ADMIN_ROLE` | SRXTimelock after the launch hand-over (the Safe holds none on this contract) | Role management |

There is no `UPGRADER_ROLE`: the contract cannot be upgraded or replaced in place. A fix ships as a new contract that holders choose to move to (`docs/MIGRATION.md`).

No EOA should hold `GOVERNANCE_ROLE` at mainnet. All governance actions must flow through the Governor + Timelock.

---

## 10. Important Notes for Mainnet

- `updateTierParams()` immediately affects ALL current stakers — a Slate staker can become None-tier instantly if the threshold is raised. Document clearly before any governance vote changes thresholds.
- `setRewardRate()` also takes effect immediately on the accumulator for all stakers.
- The 10% early withdrawal penalty goes to the dead address and is irreversible — no admin override.
- The staking reward pool (1.7B SRX) is a fixed allocation. `notifyRewardAmount` only registers SRX already held by the contract against that allocation: it accepts only free SRX, never staked principal or the existing pool, and never more than the launch distribution delivered (capped by `REWARD_ALLOCATION`). There is no rescue function for the pool (`rescueStrandedPool` was removed on 16 Oct 2026, internal audit L1): after wind-down, the unused allocation can leave only through `releaseRewardAllocation` to a named successor contract, and a successor's backing is re-read until it winds down, so it cannot be pinned at 0 (M1).
