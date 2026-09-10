# SRX Staking — Platform Overview

**Contract:** `SRXStaking.sol` (UUPS upgradeable proxy)  
**Reward pool:** 1,700,000,000 SRX (allocated at TGE, held in contract)  
**Last updated:** 16 May 2026

---

## Core Concept

Staking does two things simultaneously:

1. **Rewards long-term holders** with SRX emissions from the 1.7B reward pool
2. **Gives merchants and users fee discounts** on gateway transactions based on how much they stake

---

## 1. Locking — How to Enter

Call `lock(amount, duration)` to open a position. One position per wallet.

The **lock duration** determines a multiplier that scales your reward share (but not your tier):

| Duration | Multiplier | weightedAmount (on 1M SRX) |
|---|---|---|
| 7 days | 1.0× | 1,000,000 SRX |
| 30 days | 1.25× | 1,250,000 SRX |
| 90 days | 1.5× | 1,500,000 SRX |
| 180 days | 2.0× | 2,000,000 SRX |

The **weighted amount** is what determines your share of the reward pool — not the raw SRX locked. A 180-day staker earns 2× the rewards of a 7-day staker for the same principal.

---

## 2. Tiers — Fee Discount on Gateway

Tiers are determined by the **raw SRX locked** (not weighted amount):

| Tier | Minimum staked | Fee discount (fiat/crypto) | SRX payment discount |
|---|---|---|---|
| None | < 50,000 SRX | 0% | 100% (always) |
| Slate | ≥ 50,000 SRX | 25% | 100% (always) |
| Onyx | ≥ 250,000 SRX | 60% | 100% (always) |
| Obsidian | ≥ 1,000,000 SRX | 100% (free) | 100% (always) |

SRX payment type always carries a 100% discount regardless of staking tier — this is hardcoded in FeeController, not staking-dependent.

Obsidian-tier merchants pay **zero gateway fees on all non-SRX transactions**. This is the primary commercial incentive for large merchants to stake SRX.

---

## 3. Adding to a Position — `addToPosition(amount, newDuration)`

You can add SRX to your existing position at any time before the lock expires:

- **Tier upgrades automatically** as you cross Slate/Onyx/Obsidian thresholds
- **Duration can only extend**, never shorten — pass `0` to keep the current lock end
- **weightedAmount** is recalculated on the full position if duration is extended
- **Earned rewards are auto-checkpointed** before the position is modified — accrued rewards are never lost

Example (confirmed on testnet):
- Lock 50,000 SRX @ 7d → Slate, weightedAmount = 50,000
- Add 200,000 SRX → Onyx, weightedAmount = 250,000 (still 7d multiplier)
- Add 750,000 SRX, extend to 30d → Obsidian, weightedAmount = 1,250,000 (1.25× on full 1M)

---

## 4. Reward Mechanics

The contract uses the **Synthetix staking reward model**:

- A global `rewardPerTokenStored` accumulator grows continuously as long as `rewardRate > 0` and weighted stake > 0
- Each staker tracks `userRewardPerTokenPaid` — a snapshot of the accumulator at their last interaction
- `earned(wallet)` = `(rewardPerTokenStored − userRewardPerTokenPaid) × weightedAmount ÷ 1e18`

**Governance controls the rate.** `setRewardRate(amount)` is GOVERNANCE_ROLE only and flows through the Timelock. The rate can be adjusted up or down by governance vote at any time — this is how the protocol controls inflation.

The 1.7B SRX reward pool is designed to sustain emissions for many years. The exact rate at mainnet will be set by the founding governance vote after token launch.

**Testnet verification:**
- Rate set to 500 SRX/s (accelerated for testnet)
- Obsidian staker (1.25M weighted) earned ~6,000 SRX per 12-second block
- Production rate will be orders of magnitude lower

---

## 5. Claiming and Exiting

### `claimRewards()` — claim without unstaking
- Transfers all `earned()` SRX to the staker
- Position remains active — lock continues, weighted amount unchanged
- `userRewardPerTokenPaid` is reset to current accumulator

### `unlock()` — clean exit after lock expires
- Only callable after `lockEnd` timestamp
- Returns 100% of principal to staker
- Any unclaimed rewards are auto-paid
- Position is deleted

### `earlyWithdraw()` — exit before lock expires
- **10% of principal** permanently burned to `0x000000000000000000000000000000000000dEaD`
- **90% of principal** returned to staker's wallet
- Any earned rewards are paid in full (no penalty on rewards, only on principal)
- Position is deleted

**Testnet confirmation:**
- 1,000,000 SRX staked → 100,000 SRX burned to dead address, 906,000 returned (900K principal + 6K residual rewards)
- Dead address balance increase verified on-chain

---

## 6. USDC Real Yield Port (Dormant Until Activated)

The contract has a second reward accumulator — identical in design to the SRX rewards but for a bonus ERC-20 token (intended to be USDC from gateway fee revenue).

**Activation sequence (3 governance calls through Timelock):**

```
1. setBonusRewardToken(USDC_address)     — one-time, irreversible
2. notifyBonusRewardAmount(usdcAmount)   — fund the USDC pool from fee revenue
3. setBonusRewardRate(rate)              — control USDC emission speed
```

After activation, stakers call `claimBonusRewards()` to receive USDC — or it pays automatically on `unlock()` / `earlyWithdraw()`.

**Before activation:** All bonus functions are complete no-ops. Zero cost, zero effect on existing stakers.

**Guard:** `setBonusRewardToken()` rejects `address(srx)` as the bonus token (M-08 audit finding — would create an accounting conflict with the primary reward accumulator).

**Testnet confirmation:** Sepolia USDC address (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) set successfully via governance call.

---

## 7. FeeController Integration

The staking contract does not collect fees. `FeeController` does. When the gateway charges a user:

1. `FeeController.calculateFee(userWallet, paymentType)` is called
2. FeeController reads `SRXStaking.getTier(userWallet)` — live, on every call
3. The appropriate discount is applied from the tier lookup
4. For `PaymentType.SRX` — always returns 0, hardcoded regardless of tier

The fee routing table (up to 8 destinations: Treasury, RealYield, AutoBurn, etc.) is configured via `setFeeDestination()` and committed via `commitFeeDistribution()` — governance-controlled, no contract upgrade needed.

---

## 8. Key State Variables (for reference)

| Variable | Type | Description |
|---|---|---|
| `positions[addr]` | `Position` | amount, weightedAmount, lockStart, lockEnd |
| `rewardPool` | uint256 | Total SRX in reward pool (1.7B at TGE) |
| `rewardRate` | uint256 | SRX per second emitted to stakers |
| `rewardPerTokenStored` | uint256 | Global accumulator (Synthetix pattern) |
| `totalWeightedStake` | uint256 | Sum of all stakers' weighted amounts |
| `bonusRewardToken` | address | address(0) until activated |
| `bonusRewardRate` | uint256 | Bonus token per second (0 until activated) |

---

## 9. Roles

| Role | Who holds it | What they can do |
|---|---|---|
| `GOVERNANCE_ROLE` | SRXTimelock | `setRewardRate`, `setBonusRewardToken`, `setBonusRewardRate`, `notifyBonusRewardAmount`, `updateTierParams` |
| `PAUSER_ROLE` | GuardianModule | `pause()` / `unpause()` |
| `DEFAULT_ADMIN_ROLE` | Deployer EOA → Gnosis Safe at mainnet | Role management |

No EOA should hold `GOVERNANCE_ROLE` at mainnet. All governance actions must flow through the Governor + Timelock.

---

## 10. Important Notes for Mainnet

- `updateTierParams()` immediately affects ALL current stakers — a Slate staker can become None-tier instantly if the threshold is raised. Document clearly before any governance vote changes thresholds.
- `setRewardRate()` also takes effect immediately on the accumulator for all stakers.
- The 10% early withdrawal burn is permanent and irreversible — no admin override.
- `setBonusRewardToken()` is one-time only — the address cannot be changed once set. Choose carefully.
- Staking reward pool (1.7B SRX) cannot be refilled without a governance upgrade — it is a fixed allocation.
