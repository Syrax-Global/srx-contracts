# SRX pre-external-audit remediation

## 22 October 2026 — internal review round

**Why.** After the 16 Oct audit and the class sweep below, five independent internal reviews
went through the contracts and the deploy scripts again, at `9395487`. Each finding was proven
by a test against `9395487` before it was fixed. The contract fixes are in `688b0e9`; the
launch-gate and deploy-script fixes are in `668adb2` to `050a983`. Hardhat: 1,567 passing, 0
failing. Foundry: 33 invariants and 5 property-fuzz tests. The regression tests for the
contract fixes are in `test/internal-audit/Review22Oct.Fixes.test.js` (20 tests; all but the D-1
pin fail on `9395487`). This is an internal review, not the external audit, which is upcoming.

**Result: no Critical, one High (a deploy-process finding, E-01), four Medium (A1 and A4 open,
C1 and C7/E-02 fixed), the rest Low and Info.** Two items are open for a design decision.

### Open: waiting for a design decision (Jared and Security)

| ID | Severity | What is wrong | Why it is not fixed yet | Test |
|---|---|---|---|---|
| A1 and A4 | Medium | The hub's per-chain inbound bucket counts gross returns. One holder sending the same SRX out and back, paying the fees each time, can keep the bucket full and hold honest returns from that chain back. The same round trips can trip the bridge circuit breaker (configured on testnet only; mainnet has none). | Counting net returns would end the blocking, but would let honest sends into a compromised chain free room for forged returns, which weakens the containment bound. Kept gross for now. No funds are lost; returns are delayed. | Proven in the review; behaviour is unchanged, so no regression test. The natspec on the bucket records it as open |

### Contracts (`688b0e9`)

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| A2 | Low | `SRXToken`: a send into a chain whose returns are frozen was accepted, burning SRX that could not come back. | Refused with `InboundChainFrozen`; nothing is burned and `outstandingByEid` does not grow. | `Review22Oct.Fixes` "A2" |
| A3 | Low | `SRXToken`: a plain transfer to the hub's own address was accepted (the spoke already refused it), stranding the SRX. | Refused with `TransferToTokenContract`. Bridge credits to the address still land, and `rescueTokens` recovers them. | `Review22Oct.Fixes` "A3" |
| A5 | Info | The wallet-cap exemption for listed exits was not explained in the code. | Natspec. | none needed |
| B1 | Low | `releaseRewardAllocation` (`SRXStaking`, `StabilisationFund`) did not check what the successor did with the SRX, so a wound-down successor, or one whose reward cap was too small, could take SRX that could never be paid out as rewards. | After the successor syncs (`syncAllocation`), its reward backing must cover everything ever released to it (that backing comes only from this contract); all state is written before the calls. A wound-down or too-small successor is refused, so released SRX can only become the successor's rewards (REG-50). | `Review22Oct.Fixes` "B1 (a)" to "B1 (d)" |
| B2 | Low | `StabilisationFund.triggerStressEvent` took its snapshot before syncing the allocation, so SRX delivered since the last sync counted as free SRX and widened the caps. | The snapshot reads the allocation first. | `Review22Oct.Fixes` "B2" |
| B3 | Info | The 90-day withdraw-lock ceiling was not enforced in the fund's constructor. | `InvalidDuration` above 90 days; exactly 90 is accepted. | `Review22Oct.Fixes` "B3" |
| B4 | Info | A dust top-up could move a position's unlock time earlier after the lock was shortened. The docs said the lock was "per deposit"; it is per position. | A top-up can extend the unlock, never bring it forward. Docs say "per position". | `Review22Oct.Fixes` "B4" |
| C1 | Medium | `PreSaleRound`: once the raised ETH was withdrawn and the round finalised, a late refund could not be paid. | New `returnFunds()` (admin, payable) puts ETH back. It credits no one. | `Review22Oct.Fixes` "C1" |
| C2 | Low | `setBuyerApprovals` reverted the whole batch when one cap was below what that buyer had already bought. | The cap is raised to what the buyer bought, the agreement ref is kept, and the rest of the batch applies. | `Review22Oct.Fixes` "C2" |
| C3 | Low | `claimRefund(asset)` always paid the payer, so a payer that cannot receive ETH, or a blacklisted token holder, could not be refunded. | `claimRefund(asset, to)`: the payer chooses where its refund goes. A zero `to` reverts; nobody can claim another's refund. | `Review22Oct.Fixes` "C3" |
| C4 | Info | `quoteStable(amount, investor)` named no coin and always used USDC's feed and decimals, so a USDT quote (own feed, 18 decimals) disagreed with what a purchase credited, and a disabled coin still quoted. | `quoteStable(coin, amount, investor)` uses that coin's own decimals and feed, and reverts `CurrencyDisabled` for a coin the round does not accept (disabled, unknown or zero). | `Review22Oct.Fixes` "C4" (two tests) |
| C6 | Low | `removeInvestor` was refused after finalize, even for a wire buyer with no on-chain payment. | It works after finalize for a wire buyer. An on-chain payer is still `HasOnChainPayment`; a deployed vault is still `VaultAlreadyDeployed`. | `Review22Oct.Fixes` "C6" |
| D-2 | Low | `GuardianModule.updateModuleTarget` could repoint a module the guardian was holding paused, leaving the old contract paused with no lapse and no release after the sunset. | Refused with `ModuleAlreadyPaused` while the guardian holds that module paused; allowed once governance has unpaused it, or when the flag is stale. | `Review22Oct.Fixes` "D-2" |
| D-3 | Info | `releaseAfterSunset` was logged as a `GuardianAction`, which named a stranger as the guardian who acted. The stale-flag path of `unpauseModule` logged nothing. | `releaseAfterSunset` emits `ReleasedAfterSunset(moduleId, caller)`; a stale-flag `unpauseModule` emits its `GuardianAction`. | `Review22Oct.Fixes` "D-3 (a)" and "D-3 (b)" |
| (lead, from D-2) | Not rated | `GuardianModule` accepted any module id, and a second id on the token's target. The limits and `pauseAll` follow the module id, so an extra id gave the guardian an unbounded token pause. | Only the six `MODULE_*` ids can be registered, and only one `pause()` module per target (the bridge may share the token's). Repointing frees the old target. | `Review22Oct.Fixes` "lead" |
| Info | Info | `addWindDownExit` accepted address 0; a failed ETH rescue reverted with the unrelated `ZeroAmount`. | Address 0 refused; a failed rescue reverts `ETHRescueFailed` (the spoke too). | `Review22Oct.Fixes` |

**D-1 (not a defect; documentation corrected).** A per-chain inbound freeze is lifted only by
governance, even after the guardian's sunset. This is deliberate: after the sunset nobody else
could re-freeze a compromised chain. Any document that said the sunset bounds a freeze was
wrong and has been corrected. Pinned by `Review22Oct.Fixes` "D-1" (it passes on `9395487` too).

### Deploy scripts and the launch gate (`668adb2` to `050a983`)

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| E-01 | High (deploy process) | `SRXStaking` and `StabilisationFund` fix their `TGEDistributor` at deployment (REG-50), and 03 deploys a new distributor on every run. After a 03 re-run both pointed at a distributor that never launches: the 1.7B staking allocation arrives and can never back a reward, and the fund can deploy no SRX. Nothing compared the three addresses. | The 06 gate requires `staking.tgeDistributor()`, `fund.tgeDistributor()` and the launching distributor to be the same contract for the launch token. 03 refuses to run while staking or the fund exists unless `ACK_REDEPLOY_STAKING_AND_FUND=yes`, and a 03 re-run needs 04 and 05b re-run. (`206f1ae`) | `test/deploy/LaunchOrder.test.js` |
| C7 / E-02 | Medium | Revoked vesting SRX went to a wallet: 03 and 10 fixed where a revoked vault's unvested SRX goes before `SRXTreasury` existed, so both fell back to the treasury wallet. | `SRXTreasury` is deployed before 10 and 03 (order 01, 02, 05, 10, 03, 04, 05b, 06, 06b, 08). 03 and 10 require a real `SRXTreasury` of the launch token; the gate checks every `revokeRecipient`. (`668adb2`) | `test/deploy/LaunchOrder.test.js` |
| E-03 | Low | The role gate could not see any holder of the Timelock's proposer, canceller or admin role beyond the ones it asked about, and took the Governor address on trust, so a key with the proposer role passed as "Governor only". | It lists every proposer, canceller and admin from events (from `TIMELOCK_DEPLOY_BLOCK_<NET>`) and fails on any proposer other than the Governor, any canceller other than the Governor and the admin Safe, and any admin other than the Timelock; the Governor must be a contract tied to the Timelock and the token. (`dc852cb`) | `test/deploy/LaunchRoles.test.js` |
| E-04 | Low | The gate did not require the Safe to hold the emergency pause and the veto, or that anyone could report to the circuit breaker. | The Safe must hold `GuardianModule` `GUARDIAN_ROLE` and Timelock `CANCELLER_ROLE`; once the breaker is configured, `CIRCUIT_BREAKER_ADDRESS` must be stated and hold `CIRCUIT_BREAKER_ROLE`. 08 has no defaults. (`71be60b`) | `test/deploy/LaunchRoles.test.js` |
| E-05 | Low | The DVN check ran only for chains in `LZ_EIDS`; a hub peer on any other endpoint id was never looked at. | The hub's peers are listed from `PeerSet` events (from `SRX_TOKEN_DEPLOY_BLOCK_<NET>`); every non-zero peer must be a declared chain's declared OFT, and every peer gets the DVN check. (`f5b4a1b`) | `test/deploy/LaunchRoles.test.js` |
| E-06 | Low | `GUARDIAN_MULTISIG` meant two different multisigs in 08 and in the gate. | Split into `PAUSE_GUARDIAN` (`GuardianModule`) and `SSF_GUARDIAN_MULTISIG` (`StabilisationFund`). 08 refuses to run, and the gate fails, while the old name is set. (`ce43ad4`) | `test/deploy/LaunchRoles.test.js` |
| C5 | Low | The Genesis vault batch defaulted to 20 buyers, about 19M gas, more than one Ethereum transaction can hold (16,777,216). | Default 12 (about 11.5M gas); a batch above 15,000,000 gas is refused. (`66d32ac`) | `test/deploy/GenesisChunk.test.js` |
| E-08 | Info | 04, 05 and 05b still described UUPS proxies; the runbook used a network called `mainnet` that does not exist; two scripts printed different names for the same address. | Wording corrected (no SRX contract is upgradeable since REG-53); the network is `ethereum`; canonical names are `STABILISATION_FUND_<NET>` and `GUARDIAN_MODULE_<NET>`. (`050a983`) | `test/deploy/DeployText.test.js` |

### Other changes in the round

- **Public mirror CI (`d686a77` to `22a4257`).** The public mirror's workflows run on
  GitHub-hosted runners only; check 8 of the mirror check allows `runs-on` of exactly
  `ubuntu-latest` or `ubuntu-24.04` and refuses `pull_request_target`, `workflow_run` and any
  secret in a public workflow.
- **CI-04 (`bab6c9c`).** Pull-request CI runs `FOUNDRY_FUZZ_RUNS=256` and
  `FOUNDRY_INVARIANT_RUNS=64`, because the runner has little memory. The full depth (1,024 × 100
  and 10,000) runs nightly.
- **Contract size.** `PreSaleRound` (24,421 bytes) and `SRXToken` (23,645 bytes) sit close to
  the 24,576-byte limit, so both are built with optimizer `runs: 1` through a per-file override
  in `hardhat.config.js`. Behaviour is identical; gas is slightly higher.

## 22 October 2026 — Security's pre-external-audit work order

**Why.** Outside researchers kept reporting issues that were already fixed in development,
because the public repository was a 16 October snapshot. Security's work order (22 Oct): close
the two open items, pin two reported cases as tests, sweep every contract for each class of
mistake the public has found once, and run a second static analyser. Each fix below has a test
that fails on the old code. Hardhat: 1,261 passing. Foundry: 32 invariants and 5 property-fuzz
tests passing. Slither 0.11.6: 0 High, 0 Medium. Aderyn 0.6.8: every finding fixed or explained
in `docs/audits/STATIC_ANALYSIS_TRIAGE.md`.

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| A1 (external report, 22 Oct) | Low | `FeeController.calculateFee` and `feeBreakdown` carried `whenNotPaused`, so a paused FeeController made every fee read revert, including the SRX case, which is always 0. | The reads answer while paused. `paused()` stays the stop signal the gateway reads before accepting a payment. | `FeeController` "calculateFee and feeBreakdown still answer while paused" |
| M2 / A2 (external report, 15 Oct, #4) | Medium | `VestingVault.revoke(recipient)` took the recipient from the caller, so a revoke could name the beneficiary and make a whole locked grant liquid (a Genesis vault instantly, by the Safe). | The recipient is fixed at deployment (`revokeRecipient`, the Treasury) and can never be the beneficiary; `revoke()` takes no argument. `PreSaleRound` passes its own fixed `vaultRevokeRecipient`. | `test/internal-audit/M2.FixedRevokeRecipient.test.js` |
| A3 (reported 22 Oct) | — | Pinned: rewards owed while nobody is staked stay backed through a release, and an exited staker claims them without staking again. | Already true; now a test (mutation-checked). | `test/internal-audit/RetainedRewards.test.js` |
| A4 (Antoni) | — | Pinned: the bridge target paused directly, then the breaker threshold crossed: the trip latches, is counted, keeps the volume, and does not revert. | Already true; now a test, on the real token and the strict stub. | `GuardianPauseDesync` "breaker trip on a target already paused directly" |
| SWEEP-01 | Medium | After wind-down a release lowers `rewardBacking`, and the fund's SRX `deployLiquidity` re-read the record and raised it back, so the same allocation could be released twice, paid from free or fee SRX (REG-50). A gap in M1's fix. | `_syncAllocation` does nothing once wound down (both contracts). | `test/internal-audit/Sweep22Oct.test.js` |
| SWEEP-02 | Low | For the bridge, `setBridgePaused(true)` never fails, so (a) a trip on a stale module flag left the bridge open, and (b) a stop made outside the module was taken over as the guardian's own (M12 bypassed). | A trip always stops the bridge; `pauseModule` refuses a target already paused; `pauseAll` reads first and adopts an outside pause as governance's. | same file |
| SWEEP-03 | Low | L2's fix measured wall time, so a chain of short pauses opened the permissionless wind-down after about 5 hours of actual pause. | The 30 days count time actually paused within a run (`pausedInRun`); a break of 7 days or more starts a new run. | same file |
| TB-05 / Aderyn H-1 | Low | ETH sent with a bridge delivery (`lzReceive` is payable) had no exit on the hub or any spoke. | `rescueTokens(address(0), …)` moves ETH, behind the same 48-hour authority. | `test/internal-audit/TB05.EthRescue.test.js` |
| Aderyn H-3, L-11 | Info | Interface names declared twice; settings that never change kept in storage. | One declaration each; six settings `immutable`. | build; existing suites |
| Sweep (Info) | Info | Missing events (fund wind-down ending a stress event; reconfiguring a tripped breaker; `TGEDistributor.recoverToken`); the hub's rescue accepted itself as the destination. | Events added; self refused. | `Sweep22Oct` |

**Guarantees now tested that had no test** (found by deleting the enforcing line and seeing no
test fail): `syncAllocation` refused after wind-down (both contracts); the hub's `MAX_SUPPLY` check
in `_update` (through a test-only mint harness); `releaseAfterSunset` refusing a tripped breaker;
the fund's fee SRX never becoming releasable; the wind-down exit list being add-only, checked by
the code's structure rather than function names. New Foundry suites: staking, fund and vesting
accounting invariants (owed never above the pool; principal and owed always backed; vesting never
above the grant).

### Outside reports since 14 October, and credits

Each report is credited as its reporter agreed. "Public copy" means it was true of the public
repository (the 30 September snapshot until 16 October), not necessarily of the code in
development, which is why several had already been fixed there.

| Reported | Credit | Report | Verdict | Status |
|---|---|---|---|---|
| 14 Oct | iblitzc0de | SRX at a spoke contract's own address could never leave | Valid, Low | Fixed: transfers to the spoke refused, Timelock-only rescue (`test/EXT1014.SpokeRescue.test.js`) |
| 15 Oct | Saurav krrish | Spoke `buyAndBurn` stops while paused | By design, as on the hub (burns stop during a pause) | Documented |
| 15 Oct | Saurav krrish | Spoke `totalBurned` ignores bridge-out burns | The counter is correct (a bridge-out is not destroyed); the real gap is that a spoke burn is invisible to the hub | Open: internal audit L9 |
| 15 Oct | Saurav krrish | `TGEDistributor.setAllocations` can be replaced before `distribute()` | Info: only the Safe can call it, and the deploy steps rely on it | No change |
| 15 Oct | Saurav krrish | `VestingVault.revoke` takes an unvalidated recipient | Valid; the larger form is internal audit M2 | Fixed 22 Oct: the recipient is fixed at deployment, never the beneficiary |
| 15 Oct | Saurav krrish | A revoke during the cliff gives the beneficiary nothing | By design for launch vaults; for a paying Genesis buyer it is internal audit M3 | Open: M3 |
| 16 Oct | Saurav krrish | `claimRewards` skipped the expired-weight decay | Valid on the public copy | Fixed by REG-50 (one update hook on every entry point; `test/internal-audit/` entry-point checks) |
| 16 Oct | Saurav krrish | `rescueStrandedPool` took rewards still owed | Valid on the public copy | Fixed 7 Oct (R7-07); the rescue was then removed entirely (internal audit L1) |
| 16 Oct | kharqa | `claimBonusRewards` decayed the weight before banking SRX rewards | Valid on the public copy | Fixed by REG-50; pinned by `test/internal-audit/Kharqa.ClaimBanksAtOldWeight.test.js` |
| 22 Oct | Saurav krrish | `FeeController` fee reads revert while paused | Valid, Low | Fixed 22 Oct (A1) |
| 22 Oct | An independent researcher (credit on request) | Retained rewards with no stakers, then a rescue | Already true on development code | Pinned (A3, `test/internal-audit/RetainedRewards.test.js`) |
| Oct | Antoni | A breaker trip on a bridge already stopped directly | Holds: the trip latches, is counted, keeps its volume, does not revert | Pinned (A4, `test/GuardianPauseDesync.test.js`) |

The class sweep's tables (pause on views, twin functions, privileged outflows against what is
owed, safety latches, and every documented guarantee against a test) are held with Security.

## 16 October 2026 — internal audit (board 3af6f2d5)

**Why.** Twelve outside reports have reached us since 30 September. Most had one shape: a fix
or a limit that existed in one function was missing from its twin (the hub's rescue was fixed
and the spoke had none; staking got a minimum position and the Stabilisation Fund did not). So
we stopped answering reports one at a time and reviewed every contract ourselves, in six
independent review groups: staking, money paths, token and bridge, distribution, control, and
a claims group that checked every documented guarantee against the code. The review ran on
commit `7bc32fa` (`main` plus PR 20 and PR 21).

**Result: 0 Critical, 0 High, 12 Medium, 17 Low**, plus about 30 informational notes. Every
finding at Low or above has a passing test that demonstrates it. This is an **internal audit**.
It is not the external audit: that is upcoming and has not started, and no audit firm has
reviewed this code.

**Method, applied by every group to its own contracts:**
- a twin and sibling sweep (a parity table for every pair of functions that do the same job);
- every state-changing function: who calls it, the worst a compromised key or a typo does,
  and what stops it;
- accounting invariants on the rare paths (pause, wind-down, rescue, early exit, bridge,
  shortfall, rounding);
- every entry point, and which update hooks it runs (a skipped hook is a finding);
- funds with no exit, and rescues that could take what users are owed;
- every "never / cannot / only / at most" statement in the code comments and the documents,
  checked against the code and against a test;
- Slither 0.11.6: 0 High, 0 Medium.

**The outside reports in this window.** Reporters are not named here; they are credited only
with their consent.

| Report | Verdict | Status |
|---|---|---|
| 16 Oct: `claimRewards` skipped the decay of an expired lock's weight, which `unlock` and `earlyWithdraw` ran | Valid on `main` and on the public mirror | Fixed by REG-50 / PR 20 |
| 16 Oct: `rescueStrandedPool` could take rewards still owed to stakers | Valid on the public mirror only; `main` already refused it | Fixed on `main` 7 Oct (R7-07). The function itself was then removed on 16 Oct (L1 below) |
| 14 Oct: SRX sent to a spoke's own address was stranded, and the spoke had no rescue | Valid, Low | Fixed (board 585533e0): the spoke refuses plain transfers to itself, and its owner (that chain's Timelock) has `rescueTokens`. `test/EXT1014.SpokeRescue.test.js` |

The five 15 October reports are folded into the audit: one is by design (hub and spoke agree),
one is informational, and the other three became M2, M3 and L9 below.

### Fixed in the code

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| M1 | Medium | Anyone could make a successor staking contract or fund read its reward backing before the old contract had released the SRX. The backing was then fixed at 0 for good, and the released launch SRX arrived as free SRX (in the fund, free SRX is what governance can deploy). | `syncAllocation` is no longer one-shot. The backing is re-read until the contract winds down, and it only ever rises. | `test/internal-audit/StakingFund.Fixes.test.js` (M1, fund and staking) |
| M5 | Medium | `addToPosition(x, 0)` did not move the lock end, so SRX added a day before a 180-day lock ended got the full 2.00× weight for a day's commitment. | With 0, the lock now ends no earlier than a full term of its current duration from now. New SRX always serves a full term. | `StakingFund.Fixes.test.js` (M5) |
| M6 | Medium | SRX added to an expired lock counted for the fee tier at once and could leave in the next transaction, so one stack of SRX could give Obsidian to several addresses in one block. | Same fix: the lock is live again for a full term before the new SRX counts. | `StakingFund.Fixes.test.js` (M6) |
| M7 | Medium | The guardian could keep the token paused for 30 days without a break: unpause one second before the 14-day term ends, pause again in the same transaction. No full term was ever reached, so the 7-day block never started. | Pauses less than 7 days apart count as one run. A run holds at most 14 days of paused time, then the 7-day block applies. The 30-day total still holds. | `test/internal-audit/M7-M12.GuardianTokenPause.test.js` (M7) |
| M10 | Medium | The Governor's `quorum()` read the current quorum setting, not the one at the proposal's snapshot, so lowering it revived proposals that had already failed. | `quorum()` reads the numerator in force at the proposal's snapshot. | `test/internal-audit/M10.QuorumSnapshot.test.js` |
| M12 | Medium | The guardian could lift a token pause that governance had voted to hold, and one that governance made itself once a `pauseAll` had adopted it. The override was ineffective against the key it exists to override. | Those pauses are marked governance-only. The guardian's `unpauseModule` reverts (`GovernanceOnlyUnpause`); `governanceUnpause` and `emergencyUnpauseAll` lift them. | `M7-M12.GuardianTokenPause.test.js` (M12) |
| L1 | Low | `rescueStrandedPool(recipient)` sent the whole unaccrued reward pool to any wallet whenever nobody was staked, including right after TGE (1.7B SRX in staking). Its twin `releaseRewardAllocation` pays only a successor. | **Removed** from `SRXStaking` and `StabilisationFund`, with `RewardPoolReset`. A pool with no stakers is not stranded: accrual resumes when stakers return. After wind-down, `releaseRewardAllocation` to a successor is the only way out. | `StakingFund.Fixes.test.js` (L1) |
| L2 | Low | An unpause and re-pause (even in one block) restarted the 30-day clock after which anyone may wind a paused contract down. The guardian could hold depositors for about 203 days against the documented 30. | A break shorter than 7 days (`PAUSE_BREAK`) continues the same pause. Both contracts. | `StakingFund.Fixes.test.js` (L2, staking and fund) |
| L3 | Low | The fund's `withdrawLockDuration` applied to every existing deposit and had no upper bound, so one proposal could confine principal already past its lock, with no pause. | Each deposit keeps the lock it was made under. Governance may set at most 90 days (`MAX_WITHDRAW_LOCK`). | `StakingFund.Fixes.test.js` (L3) |
| L4 | Low | The fund had no twin of staking's `minTotalStakeForEmission`, so a lone minimum position could take the whole stream. | `minTotalForEmission`: below it, emission does not accrue. Governance-set; ships inactive (0), like staking's. | `StakingFund.Fixes.test.js` (L4) |
| L5 | Low | "No limit" set as 2²⁵⁶−1 overflowed the draining bucket the next block and bricked returns from that chain and the setter with them. The same held for the buyback's daily limit and the circuit-breaker threshold. | The inbound limit is at most `MAX_SUPPLY`. The swap per-day limit and the breaker threshold are at most 2¹²⁸−1. | `test/internal-audit/L5.LimitOverflow.test.js` |
| L6 | Low | `PreSaleRound.recoverSRX` took the whole balance, including SRX owed to buyers whose vaults did not exist yet. A 1-wei donation then forced the operator through it. | It takes only the surplus above `pendingDeployment()`. | `test/internal-audit/L6.GenesisRecoverSRX.test.js` |
| L10 | Low | The wallet cap could block a staker's own principal coming back from a staking or fund exit (`unlock`, `exitAfterWindDown`) when it was above the cap. | The cap does not apply to SRX leaving a listed wind-down exit. Ordinary transfers still respect it. | `test/internal-audit/L10.ExitAboveWalletCap.test.js` |
| L11 | Low | `earlyWithdraw` paid rewards while paused, when `claimRewards` refuses. | While paused, the principal still leaves and the rewards stay pending until the pause ends (or wind-down starts). | `StakingFund.Fixes.test.js` (L11) |
| L12 | Low | A typo in a tier threshold could give every address a discount (Slate at 0), and a lower tier could carry a bigger discount than a higher one. | Slate needs more than 0; thresholds rise strictly with the tier; discounts never fall as the tier rises (two adjacent tiers may share a discount; pinned by `BoundaryGaps23Oct` B275, B281, B286). | `StakingFund.Fixes.test.js` (L12) |
| L13 | Low | After wind-down a position kept its multiplied tier. | After wind-down a position counts its principal only. | `StakingFund.Fixes.test.js` (L13) |
| L15 | Low | A guardian pause still standing at the guardian's sunset could then be lifted only by a vote. | `releaseAfterSunset(moduleId)`: after the sunset anyone may lift a pause the guardian left. A pause that is governance's (a hold, an adopted outside pause, a tripped breaker) stays governance's. Pauses on other modules are still bounded only by the sunset (at most 180 days). | `test/internal-audit/L15.ReleaseAfterSunset.test.js` |
| L17 | Low | The documents said a compromised spoke could return "at most the inbound limit before the guardian freezes it". The true bound is the limit plus one more limit for each day of reaction time. | No code change: the wording is corrected in `AUDIT_SCOPE.md`, `SRX_TOKEN_COMPLETE_OVERVIEW.md` and `docs/CONTRACTS.md`. (`INCIDENT_RESPONSE.md` and the property test already used limit × (1 + days).) | `test/BridgeConservation.property.test.js` (unchanged) |

Also on 16 Oct: `npm audit fix` for the development tooling only (`handlebars` 4.7.10 clears
the critical advisories; nothing in the contracts or the deployed bytecode).

**Every fix's test was shown to fail on the old code** (the old code was put back and the test
watched going red), as in every round before it. Hardhat: 1,234 passing, 0 failing. Both deploy rehearsals
(`rehearse_deploy_suite.js`, `rehearse_role_migration.js`) pass with the new gate checks.

### The launch gate and the monitor

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| L14 (CONTROL-08) | Low | The circuit-breaker monitor reported bridge-outs only, so anyone holding the threshold in SRX could stop the bridge for everyone, while the direction a forged spoke uses (returns) was not counted. | `circuit_breaker_monitor.js` reports `OFTReceived` (returns) as well as `OFTSent` (`scripts/ops/lib/bridge_events.js`). That anyone can trip the breaker with their own SRX remains, by design: the trip costs them nothing but stops only the bridge, and governance resets it. | `test/deploy/LaunchGate.InternalAudit.test.js` |
| L16 (CONTROL-10) | Low | The launch gate (`verify_roles.js`) never checked the guardian's registered modules or the circuit-breaker settings, so a guardian whose registration never ran passed the gate and its `pauseAll` paused nothing; an unconfigured breaker never trips. | The gate requires all six modules registered to the right contracts and the bridge breaker configured. Step 08 configures the breaker in the Safe's batch (`BRIDGE.circuitBreaker`; the mainnet figure is Jared's decision, like the daily return limit). | same file |
| M11, gate half (CONTROL-05) | Medium | An operation the Safe schedules while it is a temporary Timelock proposer survives the hand-over, executable by anyone, and the gate could not see it. | `verify_roles.js` lists every still-pending Timelock operation from the Timelock's deployment block (`TIMELOCK_DEPLOY_BLOCK_<NET>`, required: a check that cannot look fails) and fails on any not allow-listed; `migrate_roles.js` phase 2 warns before revoking the Safe's proposer role. The design half is open (below). | same file |

### Open, for decision

Awaiting a design decision by Security and Jared. Nothing here is hidden or accepted: each stays
listed until it is decided, built and tested. Under REG-36 the public claims stay as the build
target; the claims affected are marked in the documents.

| ID | Severity | What is open | The decision |
|---|---|---|---|
| M2 | Medium | **Fixed 22 Oct 2026** (section above): the revoke recipient is fixed at deployment and never the beneficiary. | — |
| M3 | Medium | A paying Genesis buyer can be removed after their vault exists, with no refund: `refundInvestor` refuses once the vault exists and `revokeVault` sends the whole purchase elsewhere. | A refund path for vaulted buyers, or no revoke for an on-chain payer |
| M4 | Medium | On every spoke the Safe keeps `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `BURN_ROLE` directly. The spoke pause has none of the hub's limits (no maximum, no lapse, no sunset, no governance override) and the spoke's Timelock cannot lift it. | Give the spoke the hub's limits and hand its roles to the spoke Timelock |
| M8 | Medium | The Safe's Timelock veto (`CANCELLER_ROLE`) can cancel the operation that would remove it, for ever. | Whether the veto expires or can be removed another way |
| M9 | Medium | The fixed 400M quorum is about 89% of the votable launch float, so every recovery that only governance can perform is out of reach at launch. | How quorum should work at launch |
| M11 (design half) | Medium | Who may propose and cancel Timelock operations in the window before the hand-over. | Alongside the gate fix above |
| L7 | Low | Only the Safe can start a Genesis buyer's vault clock; a launch vault's scheduled trigger is open to anyone. | With M3 |
| L8 | Low | WBTC is priced at BTC/USD with no depeg feed (USDC and USDT have one). | A WBTC/BTC feed, or WBTC off the round on mainnet |
| L9 | Low | A spoke's own burns are invisible to the hub, so "10B − `totalBurned`" is false after any spoke burn. | With M4 (remove or count spoke burns) |

**Records.** About 30 stale facts in the documents (counts, line references, finding IDs, the
upgrade references that REG-53 made false) were corrected in this round. A few code comments
reuse finding IDs for other defects (for example "R7-01" in `SRXStaking.sol` is the tier-expiry
fix, but R7-01 in this file is the draining buckets): the IDs in this file are the ones to
follow. The Sepolia and BNB testnet contracts predate REG-50, REG-53, REG-54 and these fixes
and will be redeployed (`docs/ADDRESSES.md`).

## 12 October 2026 — REG-54 fixed fee limits; the token-wide pause bounded (Security ruling)

**Why.** Both whitepaper reviews (bus 20261012T1622Z, Compliance; 20261012T1624Z, Security)
found the draft promising controls the code did not enforce. Under REG-36 the promises are
the build target, so the code was changed rather than the text. Security ruled on the token
pause the same day (bus 20261012T1626Z).

| Id | Change | Proof |
|---|---|---|
| REG54-FEE | **Jared, 12 Oct.** `setFeeLimits()` let governance move FeeController's floor down to 0 and its ceiling up to 100%, contradicting "a discount never takes a fee below 0.15%". The floor (`MIN_FEE_BPS` = 15) and ceiling (`MAX_FEE_BPS` = 500) are now **constants**; the setter and `FeeLimitsUpdated` are gone. `minFeeBps()`/`maxFeeBps()` stay as getters. Governance still sets the base rate and the crypto multiplier, only between the limits. | `test/REG54.FixedFeeLimits.test.js`: pinned list of state-changing functions; no storage slot for either limit (read from the compiler's storage layout); every tier's fee stays in [15, 500] bps whatever governance sets |
| SEC-BREAKER | **A stolen monitoring key could freeze all SRX.** `MODULE_BRIDGE` targeted `SRXToken.pause()`, so a circuit-breaker trip (`CIRCUIT_BREAKER_ROLE`, a hot key) stopped every transfer until a ~10-day governance vote, repeatably. The token now has a **bridge-only stop** (`setBridgePaused`, checked in `_debit` and `_credit`; a refused return stays retryable at the endpoint). GuardianModule drives `MODULE_BRIDGE` through it, never `pause()`, and accepts a breaker on `MODULE_BRIDGE` only. | `test/SEC1012.PauseLimits.test.js` (1): a trip stops sends and returns, ordinary transfers continue, only governance reopens, a refused return is retried |
| SEC-EXIT | **A token pause blocked the exit-only withdrawals** (`safeTransfer` hit `whenNotPaused`). While paused, a transfer **out of** a governance-listed wind-down exit goes through when that contract reports `windDown()`. The holder gets their own deposit back but cannot move it on until the pause ends. `08_deploy_guardian.js` lists SRXStaking and StabilisationFund; `verify_roles.js` fails if either is unlisted. The list is **add-only** (`addWindDownExit`; Security, 12 Oct): no later vote can delist staking or the Fund and silently break the exit promise. | (2): paused + listed + wound down pays exact principal and the onward transfer reverts; not wound down, or not listed, reverts |
| SEC-PAUSECAP | **The guardian could hold the token paused until its sunset.** A guardian pause of `MODULE_TOKEN` now runs at most **14 days**; then **anyone** may call `lapseTokenPause()`, before or after the sunset. A full term starts a **7-day** repause block however it ends (so unpausing at day 14 and re-pausing an hour later is refused). Guardian token pauses total at most **30 days**, and the guardian lives at most 180 days. Only governance keeps a pause longer (`governanceHoldTokenPause`, a vote with the Timelock's delay). ⛔ **Corrected 16 Oct (internal audit M7, M12):** this row was not true as first built. Unpausing a moment *before* the term ended dodged the block (a 30-day freeze without a break), and the guardian could lift a pause that governance held. Pauses less than 7 days apart now count as one 14-day run, and a pause that is governance's can be lifted only by governance. `pauseAll` skips the token, with `ModuleCallSkipped`, when the limits refuse it. These limits are on the hub token only: ⚠️ Open, internal audit M4 (design pending): the spoke pause has none of them. | (3): lapse, block, budget of 14 + 14 + 2 days, `pauseAll` skip, lapse after the sunset, governance hold |
| SEC-SUNSET | The "at most 180 days" guardian sunset was only the deploy script's default. The constructor now refuses more (`SunsetTooLong`). | (4): 180 days accepted, one second more refused |

**Mutation proof (12 Oct):** 21 mutations, each removing one protection above; every one makes
the named suite fail (`test/SEC1012.PauseLimits.test.js`, `test/REG54.FixedFeeLimits.test.js`).
Among them: the breaker driving `pause()` again; the bridge stop ignored on send or return;
the exit exemption without the wind-down check, for unlisted contracts, or removed; lapsing
before the term; no repause block; no budget; `pauseAll` ignoring the limits; a hand-ended full
term starting no block; the sunset uncapped; the fee floor clamp removed; the floor made a
storage variable with a setter; the ceiling raised.

**What a pause still does, stated plainly for the disclosure:** governance (the Timelock, by
vote) can grant itself `PAUSER_ROLE` on the token and pause it for as long as its votes allow
(since 16 Oct, internal audit M12, only governance can lift a pause it made or holds); after the hand-over the Safe can pause the token only through GuardianModule, within the limits
above. The wind-down exemption lets a listed contract's own transfers out continue, which also
covers `releaseRewardAllocation` (Timelock only, after wind-down, to a successor) and governance's
`deployLiquidity` of the fund's free SRX (never depositors' principal or the SRX that backs rewards).

**Size:** SRXToken runtime 23,852 bytes on 12 Oct (724 under the 24,576 limit; it was 22,957);
23,843 bytes at the 16 Oct review snapshot (`7bc32fa`, 733 under). The wind-down check sits in
a private function: inlined, it cost 500 more bytes. The 16 Oct internal-audit changes to the
token (L5, L10) have moved the figure again: re-measure with `npx hardhat size-contracts`
before tagging.

## 12 October 2026 — REG-53: no SRX contract is upgradeable; wind-down instead

**Why.** Jared, 12 Oct ("Lock them"). The staking and fee-path contracts become unchangeable
before issuance. The pause stays; a fix ships as a new contract that holders choose to move to.
This also settles the law agents' open question on the upgrade path: there is none.

| Id | Change | Proof |
|---|---|---|
| REG53-PLAIN | SRXStaking, FeeController, StabilisationFund and SRXTreasury are **plain contracts**: no proxy, no UUPS, no `UPGRADER_ROLE`, no `initialize()`, no storage gap (constructor set-up; plain OpenZeppelin `AccessControl` and `Pausable`). Every other SRX contract was already non-upgradeable. | `test/REG53.NotUpgradeable.test.js`: no upgrade function or selector in the deployed code; an upgrade call from every role reverts and leaves the code unchanged; `verify_roles.js` refuses an EIP-1967 proxy (positive control run) |
| REG53-WIND | **Found by Syrax Security (12 Oct):** without upgrades, a bug plus a pause would trap users' SRX (a pause blocked every fund withdrawal, and staking exits except the penalised early exit). SRXStaking and StabilisationFund now have an **irreversible wind-down**. `startWindDown()` (Timelock, the Safe via `WIND_DOWN_ROLE`, or anyone after 30 days of continuous pause; since 16 Oct a break shorter than 7 days does not restart the count, internal audit L2) makes the contract exit-only for good. `exitAfterWindDown()` returns exactly the caller's principal, with no penalty and no lock wait, even while paused. Rewards accrued to the switch stay claimable. No role can move a holder's principal. | Tests per Security's list (several users, paused, exact principal; no double exit; deposits refused; one-way) |
| REG53-REL | **Found while writing the migration procedure:** a new version could never be backed by the one-shot launch distributor, and the old contract's unused reward allocation had no way out. `releaseRewardAllocation` (Timelock, after wind-down only) moves the allocation nobody has been promised to a successor. Since 16 Oct (internal audit L1) it is also the only way that pool can leave: `rescueStrandedPool` was removed. The old contract then acts as the successor's allocation source, so the fixed allocation keeps its chain of custody and fees still cannot enter. Capped by both the records and the SRX actually held beyond principal and owed rewards. | End-to-end v1 → v2 test (staking and fund); fee SRX never becomes releasable |

**Mutation proof (12 Oct):** each change below makes `REG53.NotUpgradeable.test.js` fail:
1. re-adding UUPS with `_authorizeUpgrade`;
2. gating the staking exit with `whenNotPaused`;
3. charging the penalty on exit;
4. gating the fund exit with `whenNotPaused`;
5. making wind-down reversible;
6. blocking accrued-reward claims while paused;
7. letting deposits into a wound-down fund.

**Records:**
- `docs/MIGRATION.md` is the opt-in procedure.
- `INCIDENT_RESPONSE.md` Recovery now has the solvency check and exit-only templates A and B, approved by Compliance (bus 424a270).

## 11–12 October 2026 — REG-50: rewards only from fixed SRX allocations (A + C)

**Why.** Syrax decided (REG-48, then REG-50 on 11 Oct) that SRX holders get no share of
Syrax's fee income. The internal law agents' preliminary view (REG-0023, for counsel review)
was that rewards paid in SRX from a *fixed* allocation are not income, but that a dormant
switch a governance vote could turn on to pay fee income is itself a contingent entitlement and
must not exist in the code. Branch `reg50-fixed-reward-pools`.

| Id | Change | Proof |
|---|---|---|
| REG50-C | **SRXStaking's second ("bonus", "real yield") reward stream was removed**: its 6 functions, events, errors and 9 storage slots. It let governance pay stakers a second token funded from platform fees, with no code change. Rewards are SRX only. | Frozen list of state-changing functions and events (`test/REG50.FixedRewardPools.test.js` SURFACE); re-adding `setBonusRewardToken` fails it |
| REG50-A | **StabilisationFund.receiveFees was removed**; fees go to the Treasury. Depositor rewards are capped for good at `rewardAllocation`, set once at deployment (at most the fund's 1.5B launch allocation; mainnet figure not yet decided, and `05b` refuses mainnet until it is). | Cap, zero-allocation, rescue-gives-no-room and SURFACE tests |
| REG50-CAP | Both pools: registrations are counted cumulatively and can never exceed the ceiling (staking: the constant `REWARD_ALLOCATION`, 1.7B). Claims and releases never give room back (the stranded-pool rescue was removed on 16 Oct, internal audit L1). | Tranche and rescue tests; Foundry POOL-1/2/4 |
| REG50-BACK | **Found by Syrax Security's review of the first commit (11 Oct):** the cap limited the *total* of rewards but not their *backing*, so SRX sent by plain transfer (fee SRX, say) could pay for rewards within the cap. Both contracts are now fixed at deployment (the constructor) to the launch `TGEDistributor` and can only register rewards against what it records delivering to them (`syncAllocation`, after distribution; new view `TGEDistributor.allocatedTo`). Since 16 Oct (internal audit M1) the record is re-read until wind-down and only ever rises, so a successor whose source is its predecessor cannot be pinned at 0. | Security's attack kept as a regression test; end-to-end test through the real distributor; Foundry POOL-1/2 with deliveries below the ceilings |
| REG50-RES | StabilisationFund: **no caller, governance included, can deploy SRX that belongs to depositors (principal) or backs rewards** (the pool and the unregistered backing). Until now governance could deploy depositors' principal. | Tests; Foundry POOL-3 |
| R7-16 | **Fixed by removal**: `recoverLiquidity` (governance could pull any token from any address that had approved the fund) no longer exists. Deployed liquidity returns by its holder sending it. | Behavioural test with an unlimited approval; SURFACE |

**Mutation proof (12 Oct):** five mutations, each caught by both the Foundry invariant
(`test/foundry/invariant/RewardPoolsInvariant.t.sol`, 256 runs × 50 calls) and the Hardhat
tests: staking backed by the ceiling instead of the delivery; the fund backed by its allocation
instead of the delivery; the fund deploying unregistered backing; staking without the
cumulative cap; governance unbound again. Security's four mutations of the first commit were
also caught.

**Deployment:** no SRXStaking or StabilisationFund contract exists on mainnet. The testnet
contracts **will be redeployed**: as of 16 Oct the published Sepolia and BNB testnet contracts
still predate REG-50, REG-53 and REG-54 and the 16 Oct fixes (`docs/ADDRESSES.md`). (The
upgrade-path question this section left open was settled by REG-53 the next day: there is no
upgrade path.)

## 7 October 2026 — three external reports, and the review that followed

Three outside parties reported issues in the public contracts. Syrax Security reproduced them
with tests the same day. Reporters are credited here only with their consent. Same rule as
every round: each fix has a test, and each test was proven by putting the old code back and
watching it fail. Branch `fix/disclosures-a-b-c`.

### The three reports

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| A (board b745f3d8) | Medium | A compromised spoke owner, LayerZero delegate or DVN set could forge SRX on that spoke and return it to Ethereum, up to everything ever sent there. The hub ledger (N-01) counts amounts; it cannot tell real SRX from forged. **This disproved the "containment" claim SPOKE-01 had been accepted on.** | **Hub:** each chain's returns are capped by a draining daily limit (`setInboundLimit`, governance), a chain with no limit set returns nothing (fail closed), and the guardian can freeze one chain's returns (`freezeBridgeInbound`) without pausing the token; only governance unfreezes. A refused return stays retryable in LayerZero, so nothing is lost. **Spoke:** the hub's address is fixed at deployment (`HubPeer`); `setPeer` accepts only it or zero. | `test/security-triage-2026-10.test.js` (A1–A7 and controls), `test/Bridge.test.js`, `test/BridgeSpoke.test.js` |
| SPOKE-01 (board 03116bee) | Medium (was "accepted") | Spoke owner actions had no delay. | **Closed.** Each spoke's owner and LayerZero delegate is that chain's own `SRXTimelock` (48 h, the Safe proposes). `07_deploy_bridge.js` deploys it and hands over (`HANDOVER`, then `FINALIZE`); `verify_spoke.js` and `verify_roles.js` refuse a spoke that is not behind it. | `test/deploy/SpokeHandover.test.js` |
| B (board 9ca23bf4) | Low | `rescueTokens` of SRX held by the token contract reverted under launch limits unless the recipient was exempt. | The token exempts itself at construction (the reporter's suggestion). | `test/security-triage-2026-10.test.js` B1, B2, control |
| C (board 93e04946) | Informational | `buyAndBurn` stops while the token is paused. | By design; now stated in the natspec and `INCIDENT_RESPONSE.md`: burns, migrations and buybacks stop while paused. | `test/security-triage-2026-10.test.js` C1–C3 |

### Found by our own review of those fixes and of every documented claim

The external report got through because a document made a promise no test checked. So every
"never / cannot / only / at most" claim in the natspec and the security documents was mapped to
a test; where none existed, one was written, and where the code was wrong, the code was fixed.

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| R7-01 | Medium | Our own first version of the inbound limit, the buyback daily cap and the circuit breaker used **fixed windows**: spending the whole allowance just before a window rolled and again just after it moved twice the limit in seconds. | All three are draining buckets (the LayerZero RateLimiter model): what is in flight drains in a straight line over the window. | "straddle" tests in `security-triage-2026-10`, `BuybackBurner`, `Guardian` |
| R7-02 (G-L1) | Medium | A circuit breaker trip **reset itself** on the first routine report after its window rolled over, which let the guardian reopen the module with nobody in governance deciding it should. | A trip stays until governance resets it. | `test/Guardian.test.js` (A4-M-02, rewritten) |
| R7-03 | Medium | `SRXAirdrop.setMerkleRoot` could replace a **live** round's root, so the admin could re-point an open round and drain it. | Refused while the round is open (`RoundStillOpen`). | `test/SRXAirdrop.test.js` |
| R7-04 | Medium | `verify_tge` compared the wallet cap with what each vault could release **today**, which is 0 for every launch vault, so it could never fail; it also skipped the Genesis vaults. A beneficiary above the cap would be locked out of `release()` when its cliff ended. | Compares the cap with each beneficiary's **whole remaining entitlement**, Genesis vaults included (`lib/launch_checks.js`). | `test/deploy/LaunchChecks.test.js` (the lock-out reproduced on chain) |
| R7-05 | Medium | With launch protection on, a large staking unlock exceeded the transfer cap, and once 0xdEaD had received early-exit penalties up to the wallet cap every further early exit reverted. | `verify_tge` refuses launch protection until the token, staking, treasury, fund, distributor, 0xdEaD, every vault and the Genesis round are exempt. | `test/LaunchProtectionStaking.test.js` |
| R7-06 | Medium | The Timelock's delay could be lowered by a proposal through the Timelock itself, below the 48 h every document relies on. | `SRXTimelock.minDelayFloor` (set at deployment); `updateDelay` below it reverts `DelayBelowFloor`. `verify_roles` checks both. | `test/TimelockFloor.test.js` |
| R7-07 | Low | A staker who had unlocked could not claim rewards already earned, and `rescueStrandedPool` could take them. | `claimRewards` no longer needs a live position; the rescue takes only the pool above what is owed. (The rescue was removed altogether on 16 Oct, internal audit L1.) | `test/StakingRewardsOwed.test.js` |
| R7-08 | Low | `tge_targets` accepted any contract as "the multisig". | It asks the address for `getOwners()` and `getThreshold()` and refuses a threshold below 2. | `test/TgeDestinationControls.test.js` |
| R7-09 | Low | `06_execute_tge.js` checked the Timelock operations' readiness only at step 3, after the irreversible steps had run. | Checked before step 0. | `test/TgeDestinationControls.test.js` |
| R7-10 | Low | The circuit breaker kept accepting reports, and could trip, after the guardian's sunset. | `recordBridgeActivity` (and the new `freezeBridgeInbound`) refuse after the sunset. | `test/Guardian.test.js` |
| R7-11 | Low | `FeeController` rounded twice, charging 44 bps where the documented rate gave 45. | One rounding step, shared by `calculateFee` and `feeBreakdown`. | `test/FeeController.test.js` |
| R7-13 | Info | Four contract comments promised more than the code does: GuardianModule "prevents flash-unpausing" (only re-pausing has a cooldown; unpausing is immediate, by design, so a false alarm can be lifted); VestingVault "surplus recoverable before TGE" (only after); PreSaleRound "an on-chain payer's allocation cannot change any other way" (it can grow through `addInvestor` when they also pay by wire, within their approval cap; it cannot be set or reduced); SRXGovernor "4% of delegated supply must vote FOR" (4% of the fixed 10B cap, For and Abstain both count). | Comments corrected to what the code does; each behaviour now pinned by a test. | `test/Gaps.*.test.js` (G6, V6, P11, GV3) |
| R7-14 | Medium (deployment) | Found on the testnet proof: the bridge deploy set no **enforced options**, so every transfer with empty options reverted at the quote; the first value chosen (200,000 gas) was then too low for a return to Ethereum (measured 327,000), so LayerZero's executor could not deliver it. | 07 `SET_PEERS` sets each pathway's delivery gas (`BRIDGE.lzReceiveGas`, 500,000); `verify_roles` and `verify_spoke` refuse a pathway without it. The under-gassed return was re-delivered by hand, so nothing was lost. | `test/deploy/DvnCheck.test.js`; Sepolia ↔ BSC testnet, 7–8 Oct |
| R7-15 | Medium (deployment) | The "at least two DVNs, never the LayerZero defaults" rule was manual. Read on chain on 7 Oct, the testnet default was one DVN. | 07 `SET_DVNS` sets each chain's own libraries and requires every listed operator to agree (testnet: LayerZero Labs + Nethermind); both verifiers read it from the endpoint. Mainnet operators are an open decision. | `test/deploy/DvnCheck.test.js`; live negative control on an unconfigured pathway |
| R7-16 | **Fixed 12 Oct by REG-50 (removed; see the section above)** — Medium (trust) | Found 8 Oct when Slither's repo-wide exclusions were removed: `StabilisationFund.recoverLiquidity` lets GOVERNANCE_ROLE pull any token from **any address that approved the fund**, including a contributor's wallet beyond what they contributed (an unlimited approval makes that their whole balance). Behind the 48 h Timelock after the hand-over, but a passed proposal could still do it. No value is exposed: nothing is on mainnet. | **Held for the REG-48 StabilisationFund redesign** (no build on the fund before the law agents report). The redesign must restrict the pull to the fund's own approved deployment targets, or remove it in favour of the target pushing funds back. Marked in the code as an open finding, not an accepted risk. | to be written with the fix |
| R7-17 | Low (tooling) | Three Slither detectors that report High or Medium (`arbitrary-send-erc20`, `arbitrary-send-eth`, `reentrancy-no-eth`) were excluded for the whole codebase, so a new occurrence anywhere would have passed CI. Foundry and forge-std were unpinned. | Exclusions removed; each existing occurrence carries its own dated reason (R7-16 is marked open, not accepted). forge v1.8.5 and forge-std v1.16.1 pinned. | Mutation: a throwaway unguarded ETH send made Slither fail as High |
| R7-12 | Info | `scripts/ops/pre_mainnet_roles.js` predated the two-phase migration and would grant roles the gate now forbids. | It refuses to run and points to `migrate_roles.js`. | — |

### Tools

Slither 0.11.6 (latest): **0 High, 0 Medium.** It reported 3 High and 32 Medium; 2 were fixed and
30 are justified in place with a dated `slither-disable-next-line` comment each. CI now runs the
same version and fails on Medium, not only High.


## 1 October 2026 — a researcher's report, and three board findings

Same rule: each fix has a test, and each test was proven by breaking the fix on purpose
(mutation) and watching the test fail. Commit `5cbbf2d`.

| ID | Severity | Defect | Fix | Tests |
|---|---|---|---|---|
| SSF-L1 | Low (was "accepted") | A 1-wei StabilisationFund position kept `totalContributions` above zero, so it blocked the stranded-pool rescue (`rescueStrandedPool`, removed on 16 Oct, internal audit L1) and a dust contributor sat on the whole reward stream with no capital at risk. The minimum that fixed this in staking (F5) was never carried over. Reported by **ibnu76** (20 Sep). | `minContribution`, 100 SRX by default like `minStakeAmount`, governance-settable. A position is 0 or at least the minimum, on contribute and on partial withdrawal. | `test/StabilisationFundMinimum.test.js` (the reporter's dust PoC) |
| SC-TRUST-001 (board 45d8fd15) | High (design) | Upgrade and spending rights were documented as "Timelock only" but administered by `DEFAULT_ADMIN_ROLE`, so its holder (the Safe until hand-over) could grant itself `SPENDER_ROLE` and empty the treasury, or re-grant `UPGRADER_ROLE`, with no delay. Only the launch gate checked the end state. | `UPGRADER_ROLE` (then on all four upgradeable contracts; it no longer exists since REG-53) and `SPENDER_ROLE` (treasury) administer themselves. `GOVERNANCE_ROLE` as their admin was rejected: the Safe holds it until hand-over. | `test/RoleSeparation.test.js` |
| BB (board 132c0422) | Low | `BuybackBurner.maxSlippageBps` was read by nothing: with no on-chain price there was nothing to apply it to, yet it read as a control. | Removed, with its setter, constant, event and error. An on-chain price bound from the official pool's average is a design item for after the pool exists. | `test/BuybackBurner.test.js` (the setting must not exist) |
| GOV (board a810a5af) | — (already fixed) | The Timelock delay shipped as a 60-second constant against a documented 48 hours. Fixed on 10 Sep (`bd3d05e`) by deriving it from the network, but never tested. | No change. | `test/deploy/TimelockDelay.test.js` |

The same report's first finding is **SSF-H2** below, which was fixed on 23 Sep, after his report. His third finding (a
rescue taking rewards already earned) was covered by that fix. A test now proves his exact scenario: the rescue
takes only the unearned part, and the earned part stays reserved until he claims it.

## Pre-external-audit sweep — 23 September 2026

A second full pass over every in-scope contract and the deploy and operations
scripts, done to hand the code to an external auditor. Same rule as before:
**a finding counts only once a test proves it.** Every fix below has a test that
was red against the code as found and is green now — proven by swapping the old
contract back in, not by reasoning. The tests are in
`test/audit-poc/pre-external-audit.test.js` unless stated.

### ⛔ One correction to the 10 September record

**F6 was recorded as fixed below, and was not.** Its proof test asserted the
*buggy* behaviour (2.00× weight after `addToPosition` on an expired lock), so it
stayed green over the defect. Fixed in `45e81f5`: an expired lock's weight
decays to 1.00×; the test now asserts 1.00× and F6c covers the increase path.
Lesson recorded: a proof test is re-read against the claim, not only run.

### ✅ Fixed

| ID | Severity | Defect | Fix | Commit |
|---|---|---|---|---|
| PSR-01 | Critical | PreSaleRound assumed payment tokens had 6/6/8 decimals and never read them. On BNB Chain USDT and USDC are 18-decimal, so every deposit was valued 10¹² too high: 0.0000025 USDT bought the whole 300M SRX cap | Decimals read from each token at deployment; every feed must be 8-decimal USD | `e3ae4e5` |
| GOV-H1 | High | The launch gate *required* the admin Safe to keep `DEFAULT_ADMIN_ROLE` everywhere, so one Safe batch could grant itself spend or upgrade rights, or move the StabilisationFund's 1.5B SRX, with no delay | Delay-only at launch: every admin power behind the 48h Timelock; the Safe keeps pause and a veto. Gate, two-phase migration and an end-to-end rehearsal (`scripts/ops/rehearse_role_migration.js`) | `7255ae0` |
| SSF-H2 | High | StabilisationFund scheduled rewards against its whole pool, accrued-but-unclaimed included, and zeroed a capped claim — the F1/F1b defect fixed only in staking. First reported by **ibnu76** (20 Sep) | `totalPendingRewards`, scheduled against the unaccrued pool, shortfall retained with `RewardShortfall` | `48d9f00` |
| STK-H2 | High (dormant until a bonus token is set) | The staking bonus stream had the same defect | `totalBonusPendingRewards`, same model. Moot since REG-50 (11–12 Oct): the bonus stream was removed from the code | `48d9f00` |
| SSF-M1 | Medium | Fast-path caps were a share of the whole balance, contributor principal included; a guardian deploying its full cap left contributors unable to withdraw in full | Caps and deployments measured against free SRX only | `48d9f00` |
| STK-M1 | Medium | Per-update flooring left the global liability a few wei below the sum of claims; an unchecked subtraction then wrapped to ~2²⁵⁶ and froze emissions | Clamped subtraction | `48d9f00` |
| PSR-02 | Medium | `updateAllocation` inside a tier jump recorded more USD than any payment could produce; a $1 top-up then repriced at the higher tier (+3.45M SRX for $1 at $400k) | Refused as `AllocationNotRepresentable` | `a411ff1` |
| PSR-05 | Medium | No minimum contribution: 1 unit of USDC created an investor, so dust wallets could bloat the list and cost a vault each | `setMinContribution`; the deploy script sets $2,500 | `a411ff1` |
| PSR-06 | Medium | Removing an investor (e.g. failed KYC) kept their ETH or stablecoins; nothing recorded what anyone paid | Payments recorded per investor and asset; `refundInvestor` + `claimRefund`; owed refunds ring-fenced from withdrawals and must be fully held; a payer cannot be removed any other way | `080efaa` |
| N-01 | Medium | Every chain was peered to every other, and the peer list mixed testnet and mainnet | Hub-and-spoke: spokes talk only to Ethereum (`hubEid` immutable); Ethereum re-credits a chain only up to what it sent there | `a86f6a3` |
| N-02 | Medium | The bridge's real authority (OApp owner, endpoint delegate) sat outside the role model and nothing checked it | `Ownable2Step`, renounce disabled; the gate checks owner and delegate | `a411ff1`, `7255ae0` |
| N-03 | Medium | `migrate()` always credited `msg.sender`, so a contract wallet could lose migrated funds | `migrateTo(amount, recipient)`; the payer is emitted too | `a411ff1` |
| BB-M2 | Medium | The buyback executor supplied swap calldata with nothing bounding it, and approvals accumulated | Per-token per-swap and 24h caps (no caps = no swaps), exact approval reset to zero, overspend check | `fb8badc` |
| G-L1 | Low | The guardian could re-open a tripped circuit breaker | `unpauseModule` refuses while tripped; governance resets it | `a411ff1` |
| N-06 | Low | The airdrop admin could end a live claim window at will | A round lasts ≥ 7 days; a live deadline can move later, never earlier | `a411ff1` |
| PSR-07 | Low | One already-triggered vault reverted the whole launch-day TGE batch | Skipped | `a411ff1` |
| PSR-08 / N-04 | Low | A presale vault's grant was undeclared, and its rescue was unreachable because the presale is its admin | Grant declared at creation; `rescueVaultSurplus` pass-through | `080efaa` |
| PSR-10 | Low | No pause short of the one-way `finalize` | `setPaused` | `080efaa` |
| PSR-11 | Low | The presale admin is immutable, while the spec said it would later move to the Safe | The deploy script refuses a mainnet admin with no code; spec corrected | `080efaa` |
| PSR-04 | Medium (operational) | Contract defaults block the ETH/BNB path (5-minute staleness against an hourly heartbeat) and leave price bounds off | Deploy script sets staleness, bounds, stablecoin feeds and the minimum, checking each feed's on-chain description | `080efaa` |
| PSR-12 | Info | Price views skipped the checks (a negative answer read as 2²⁵⁶−1); a future `updatedAt` panicked; staleness unbounded; stablecoins credited above par; USDT credited at nominal | One validated feed reader; 25h staleness cap; par cap; balance-delta crediting | `080efaa` |
| PSR-13 | Info | Operator instructions told the admin to call a locked setter | Corrected | `080efaa` |
| G-I1 / G-I2 | Info | Vault rescues and fee-limit changes emitted nothing | `DonatedTokensRescued`, `FeeLimitsUpdated` (the fee-limit event and its setter were removed by REG-54, 12 Oct) | `4677a9b` |
| DEP-01 | High (deployment) | The deploy suite sent admin-only calls from the deployer, which reverts once the admin is the Safe — and the only workaround was to make the deployer the admin while genesis minted 10B SRX | `scripts/deploy/lib/adminTx.js`: an admin-only call executes directly when the signer is the admin (testnets) and is otherwise written to a Safe Transaction Builder batch. Scripts 03, 05, 05b, 06, 07, 08 and 09 converted; 08 no longer grants the deployer a temporary governance role; 06 queues genesis, distribution and the vault triggers, then stops until the Safe has executed them. Tested by `test/deploy/adminTx.test.js` (a queued call executed by the admin takes effect) and by `TgeDestinationControls.test.js`, which now requires every TGE call to go through the batch. ⚠️ Not yet rehearsed end to end on a live testnet deployment | `4677a9b` |
| DEP-02 | Medium (deployment) | `02_deploy_governance.js` granted Timelock roles from the deployer, which is not the Timelock's admin — it reverts on any real deployment | Governor named as proposer in the Timelock constructor by predicted address; the script refuses a wrong prediction | `7255ae0` |

### ⚠️ Open or accepted — for the auditor's attention

- **PSR-03 — settled (Jared, 30 Sep and 1 Oct 2026).**
  - **Funding:** the Genesis round is funded from the seed allocation. At launch the
    Genesis contract receives exactly what it sold and the seed vault the rest, both
    on the seed schedule (`scripts/deploy/lib/genesis_seed.js`, `06b_genesis_vaults.js`;
    `test/GenesisSeedFunding.test.js`; the deploy rehearsal runs a two-buyer round end
    to end). Exactly, because anything above what buyers are owed can be taken out through `recoverSRX()`, unlocked. (Until 16 Oct `recoverSRX()` took the whole balance, buyers' SRX included; since internal audit L6 it takes only the surplus above what buyers are owed.)
  - **Chain:** Ethereum, the launch chain, as one contract with one cap.
    `10_deploy_presale.js` refuses any other real network.
  - Payments are made on Ethereum from the buyer's own wallet once the Syrax Vault
    signs there; until then by bank transfer, recorded with `addInvestor`.
- **SPOKE-01 — closed 7 Oct 2026.** It was recorded here as bounded by N-01. External
  report A showed that bound was not containment: N-01 caps returns at what was sent, and
  a compromised spoke can forge all of it. Each spoke is now behind its own Timelock, and
  the hub caps and can freeze each chain's returns. See the 7 October section above.
- **PSR-09 — operational.** Deploy presale vaults before `maxWalletBalance` is
  switched on; a new vault cannot be exempted in advance. In the deploy script
  and the spec's mainnet blocker list.
- **STK-L1 — moot since REG-53 (12 Oct).** It read: new staking and fund state was
  appended above the storage gaps, but neither contract had a reinitializer, so
  upgrading a proxy that held positions would have started the new liability counters
  at zero beside real accruals. No SRX contract is a proxy any more: there is nothing
  to upgrade, and a new version is a fresh deployment that holders choose to move to.
- **SSF-L1 — fixed 1 Oct 2026 (`5cbbf2d`), no longer accepted.** It was recorded here
  as accepted, while the reply to the reporter said a fix was coming. He noticed the
  contradiction. See the 1 October section above.
- **N-05 — informational.** The migration oracle must key settlements on
  (source chain id, emitter, request id); documented in `ZkSyncMigrator`.
- **PSR-12 (residual) — no L2 sequencer check.** Irrelevant on Ethereum and BNB
  Chain; the presale must not be deployed on an L2 without one (ties to PSR-03).

---

## Remediation of 10 September 2026

**Merged to `main` 10 September 2026** (branch `fix/audit-p0`, then `fix/audit-remaining`). Full suite: **726 passing, 1 pending, 0 failing.**

Every item below is backed by a test in `test/audit-poc/`. Those tests originally
**passed because the code was broken**; a fixed item's test now asserts the
correct behaviour instead. Run them with:

    npx hardhat test test/audit-poc/*.test.js

✅ **The first 20 are merged to `main` (`4157b58`).** The final three fixes and
the dispositions below are on `fix/audit-remaining`.

---

## Status: 23 fixed · 1 mitigated · 6 by-design or checked · 0 unaddressed · 1 clean

⭐ **Every one of the 31 proven findings now has a disposition.** Nothing is left
simply open.

### ✅ Fixed

| # | Defect | Fix |
|---|---|---|
| A | Origin `SRXToken` minted past `MAX_SUPPLY` on an inbound LayerZero credit — measured `2e28` against a `1e28` cap | Cap enforced in `_update`, the chokepoint every mint passes, rather than in `_credit` |
| E | Remote `SRXOFTNative` had no supply cap at all | Same cap, same place |
| T1 | A zero-value transfer reverted when the recipient was over `maxWalletBalance` — an EIP-20 conformance break that fails exchange integration probes | Launch-protection checks now gated on `value != 0`, with a control asserting the cap still bites on a non-zero transfer |
| V1 | Repeated `release()` extracted 999,855 of 1,000,000 at the vesting **midpoint** | `totalAllocation()` no longer double-counts |
| V2 | Presale vault yielded 33% at the TGE instant against a stated 25% | same one-line fix |
| V3 | `totalAllocation()` grew on every claim (1,000,000 → 1,250,000) | same |
| V4 | `revoke()` bricked once a beneficiary had released | same |
| V7 | One prior `release()` diverted ~360,000 tokens from treasury to beneficiary | same |
| TGE | `distribute()` ran on an **empty allocation set**, burned the one-shot flag, and left `recoverToken()` sweeping all 10B SRX to one address as the only move | Refuses an empty set; re-checks it actually moved `MAX_SUPPLY` |
| F1 / F1b | Emission scheduled against the **gross** `rewardPool`, re-promising tokens already owed. A 10 SRX top-up extended the schedule to 1010s where ~110s was funded | Scheduled against the **unaccrued** pool via `totalPendingRewards` |
| F1 | `_settleRewards` zeroed `pendingRewards` after capping, **destroying the shortfall** with no revert and no event | Remainder retained and claimable; `RewardShortfall` emitted |
| F3 | `earlyWithdraw` charged its 10% penalty on locks that had **already expired** | No penalty after `lockEnd` |
| F5 | A **1-wei** position collected the entire emission stream — 1,166,400 SRX in a day — and blocked `rescueStrandedPool()` (removed on 16 Oct, internal audit L1) | `minStakeAmount` of 100 SRX |
| F6 | `addToPosition(x, 0)` added capital at 2.00× on an expired lock | ⛔ **Not fixed on 10 Sep** — its test asserted the bug. Fixed 23 Sep in `45e81f5`; see the correction above |
| F6b | A 1-wei 180-day seed lock minted a permanent 2.00× slot | Closed by `minStakeAmount` |
| C | `setPeer` was `whenNotPaused`, so `INCIDENT_RESPONSE.md` step 5 — freeze bridge peers — **reverted during the incident it is written for** | Pause is a transfer circuit-breaker, not an admin lockout; `setPeer` stays `onlyOwner` |
| M1 | Deploy script's revoke was skipped in exactly the required configuration, leaving the admin EOA with `GOVERNANCE_ROLE` while the checklist claimed "Timelock only" | Unconditional, performed last |
| M2 | `migrate()` **reverted on every fresh deployment** — the script never granted `BURN_ROLE` | Granted as step 4; script exits non-zero if it cannot |
| M3 | Two chains emitted **byte-identical `MigrationRequest` payloads** — no domain separator, so a request replays cross-chain | Chain id in the high 128 bits; `srcChainId` also emitted |
| M4 | Tokens sent to the migrator were unrecoverable | `rescueTokens()`, governance-only |
| M5 | A stranded balance plus `maxWalletBalance` **bricked `migrate()` for every user, permanently** — the migrator is the recipient of the pull-then-burn | Deploy script exempts the migrator; it is a burn address in practice, never a holder |
| T3 | Governance quorum was 4% of **live** Ethereum-side supply, so bridging tokens away lowered the bar for your own proposal — 400M at 10B, 160M at 4B | Denominator pinned to the fixed global cap, read from the token rather than hardcoded |
| V5 | A vault's grant was "whatever happens to be in it" — a misdirected transfer vested to the beneficiary, recoverable only by `revoke()`, which destroys the schedule | `declareExpectedAllocation()`, called by the deploy script for all five vaults; also fails an underfunded vault at setup |

### ⚠️ Mitigated, not eliminated

**F2 — an untouched expired position keeps its 2.00× multiplier.**

`rewardPerToken()` divides by `totalWeightedStake`, so an "effective weight"
computed inside `earned()` would not match the denominator and would corrupt the
accumulator for every staker. The stored weight must actually change, and no
transaction runs at `lockEnd` — so the decay is lazy.

`pokeExpiredPosition()` is **permissionless**: a staker enjoying 2× at zero
commitment will not volunteer, so anyone may strip a stale weight, and the
caller's reward is a larger share of the stream. That turns an indefinite leak
into one bounded by somebody caring. Eliminating it outright needs a different
reward model — a redesign, not a fix.

### ⛔ Open

**By design, and the documentation is what needs correcting — not the code:**

- **B — bridged tokens bypass launch protection.** `SRXToken.sol:106-114` (it was `:82-88`) requires
  the exemption list to include *"DEX liquidity pool addresses, and the bridge"*.
- **T2 — exempting a DEX pool disables `maxTransferAmount` for every trade.** Same
  requirement, same line.
- **D — `setDelegate` is not pause-guarded.** Flagged as inconsistent because
  `setPeer` was. With the model applied consistently — pause stops transfers,
  owner-gating stops admin actions — neither should be, so this is settled rather
  than outstanding.

⭐ Together these mean launch protection **deliberately excludes the two
highest-volume paths**. It is a friction measure on direct wallet-to-wallet
transfers during the launch window, not an accumulation cap. That is defensible —
capping an `lzReceive` risks a message that can never be delivered, burning
tokens on the source chain and never minting them on the destination — but the
documentation implies a guarantee the design excludes. **Correct the claim.**

**Dispositioned, with the reasoning:**

**V6 — a config hazard that is now CHECKED rather than designed away.**
`maxWalletBalance` caps the RECIPIENT and ignores the sender, so a vesting vault
paying out is capped like any other transfer even though the vault is exempt. Set
the cap below a vault's releasable amount and the beneficiary cannot claim at
all. ⛔ **It cannot be fixed by exempting the sender:** `SRXToken.sol:106-114`
*requires* DEX pool addresses to be exempt, so that change would let every
purchase from the pool bypass the cap and defeat launch protection outright — a
worse outcome than the bug. `scripts/ops/verify_tge.js` now **fails** if any
beneficiary's releasable amount would breach the cap, turning a silent deadlock
into a caught misconfiguration.

**F4 — by design, once F3 landed.** `unlock()` is `whenNotPaused`, and `claimRewards()`
refuses while the contract is paused (in wind-down it works even while paused, REG-53), so
during a pause `earlyWithdraw` is the only exit. (Since 16 Oct, internal audit L11,
`earlyWithdraw` leaves the rewards pending while paused instead of paying them.) Since F3, an
**expired** lock exits whole. What remains is that a staker with a **live** lock
pays the 10% penalty to leave during a pause — which is correct, because they are
in fact exiting early, and they can wait for the unpause instead.

**T4 — upstream OpenZeppelin behaviour, not a Syrax defect.** `ERC20Permit` and
`ERC20Votes` share one `Nonces` counter in OZ v5, so a `permit()` consumes a
nonce a pre-signed `delegateBySig` was relying on. Every token combining those
two extensions behaves this way. Separating the nonce spaces means diverging from
the audited library, which carries more risk than the issue. Recorded so an
auditor is not surprised by it.

### ✅ Checked and clean

**T5** — self-transfer, clock mode and the permit domain are conformant.

---

## Deferred to a pre-mainnet decision

**`minTotalStakeForEmission` ships INACTIVE (0).** The mechanism is built and
tested; the value is not guessed. A candidate of 1,000,000 SRX (the Obsidian
floor) broke **17 existing tests**, because the suite stakes smaller amounts and
legitimately expects accrual. That is a signal about blast radius, not a test
problem: shipping a live economic gate whose threshold was chosen without
production data is how a launch gets bricked by its own safety control.
Governance sets it when expected participation is known.

---

## Two mistakes made during remediation, recorded because they generalise

**1. I repeated the storage bug I had just raised as a P0.** `totalPendingRewards`
was first declared **mid-layout** beside `rewardPool`, instead of appended above
`__gap` — the identical defect this audit raised against `StabilisationFund`,
where `periodFinish` sits between `rewardPool` and `userRewardPerTokenPaid` and
shifts seven variables by one slot on the deployed proxy. Writing the finding did
not prevent repeating it a day later; **re-reading the gap discipline in the file
did.** All new state is now above the gap, shrunk by exactly three (48 → 45).

**2. The reward-liability ledger was wrong the first time.** It was maintained
per-user, so a **global** update — exactly what the funding and rate-setting paths
perform — left every other staker's accrual uncounted. F1 went green while F1b
stayed red, which is what exposed it. The delta in `rewardPerToken` applies to
the whole weighted stake by construction, so it is now accrued against
`totalWeightedStake` on every update, independent of who triggered it.

**And a third, caught by the existing suite rather than by me:** placing the
weight decay inside `_updateReward` would have let `_updateBonusReward` compute
bonus accrual against the already-reduced weight, underpaying stakers. Moving it
then made `unlock()` and `earlyWithdraw()` underflow, because both snapshot the
position into **memory** before settlement and held a stale weight. The
pre-existing *"unlocking clears the tier entirely"* test caught that — the
694-test suite earned its keep.
