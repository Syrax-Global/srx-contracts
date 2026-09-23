# SRX pre-external-audit remediation

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
stayed green over the defect. Fixed in `44e505e`: an expired lock's weight
decays to 1.00×; the test now asserts 1.00× and F6c covers the increase path.
Lesson recorded: a proof test is re-read against the claim, not only run.

### ✅ Fixed

| ID | Severity | Defect | Fix | Commit |
|---|---|---|---|---|
| PSR-01 | Critical | PreSaleRound assumed payment tokens had 6/6/8 decimals and never read them. On BNB Chain USDT and USDC are 18-decimal, so every deposit was valued 10¹² too high: 0.0000025 USDT bought the whole 300M SRX cap | Decimals read from each token at deployment; every feed must be 8-decimal USD | `26925a9` |
| GOV-H1 | High | The launch gate *required* the admin Safe to keep `DEFAULT_ADMIN_ROLE` everywhere, so one Safe batch could grant itself spend or upgrade rights, or move the StabilisationFund's 1.5B SRX, with no delay | Delay-only at launch: every admin power behind the 48h Timelock; the Safe keeps pause and a veto. Gate, two-phase migration and an end-to-end rehearsal (`scripts/ops/rehearse_role_migration.js`) | `8507136` |
| SSF-H2 | High | StabilisationFund scheduled rewards against its whole pool, accrued-but-unclaimed included, and zeroed a capped claim — the F1/F1b defect fixed only in staking | `totalPendingRewards`, scheduled against the unaccrued pool, shortfall retained with `RewardShortfall` | `55e3b5a` |
| STK-H2 | High (dormant until a bonus token is set) | The staking bonus stream had the same defect | `totalBonusPendingRewards`, same model | `55e3b5a` |
| SSF-M1 | Medium | Fast-path caps were a share of the whole balance, contributor principal included; a guardian deploying its full cap left contributors unable to withdraw in full | Caps and deployments measured against free SRX only | `55e3b5a` |
| STK-M1 | Medium | Per-update flooring left the global liability a few wei below the sum of claims; an unchecked subtraction then wrapped to ~2²⁵⁶ and froze emissions | Clamped subtraction | `55e3b5a` |
| PSR-02 | Medium | `updateAllocation` inside a tier jump recorded more USD than any payment could produce; a $1 top-up then repriced at the higher tier (+3.45M SRX for $1 at $400k) | Refused as `AllocationNotRepresentable` | `6acff7d` |
| PSR-05 | Medium | No minimum contribution: 1 unit of USDC created an investor, so dust wallets could bloat the list and cost a vault each | `setMinContribution`; the deploy script sets $2,500 | `6acff7d` |
| PSR-06 | Medium | Removing an investor (e.g. failed KYC) kept their ETH or stablecoins; nothing recorded what anyone paid | Payments recorded per investor and asset; `refundInvestor` + `claimRefund`; owed refunds ring-fenced from withdrawals and must be fully held; a payer cannot be removed any other way | `a809135` |
| N-01 | Medium | Every chain was peered to every other, and the peer list mixed testnet and mainnet | Hub-and-spoke: spokes talk only to Ethereum (`hubEid` immutable); Ethereum re-credits a chain only up to what it sent there | `ac9db02` |
| N-02 | Medium | The bridge's real authority (OApp owner, endpoint delegate) sat outside the role model and nothing checked it | `Ownable2Step`, renounce disabled; the gate checks owner and delegate | `6acff7d`, `8507136` |
| N-03 | Medium | `migrate()` always credited `msg.sender`, so a contract wallet could lose migrated funds | `migrateTo(amount, recipient)`; the payer is emitted too | `6acff7d` |
| BB-M2 | Medium | The buyback executor supplied swap calldata with nothing bounding it, and approvals accumulated | Per-token per-swap and 24h caps (no caps = no swaps), exact approval reset to zero, overspend check | `17cea68` |
| G-L1 | Low | The guardian could re-open a tripped circuit breaker | `unpauseModule` refuses while tripped; governance resets it | `6acff7d` |
| N-06 | Low | The airdrop admin could end a live claim window at will | A round lasts ≥ 7 days; a live deadline can move later, never earlier | `6acff7d` |
| PSR-07 | Low | One already-triggered vault reverted the whole launch-day TGE batch | Skipped | `6acff7d` |
| PSR-08 / N-04 | Low | A presale vault's grant was undeclared, and its rescue was unreachable because the presale is its admin | Grant declared at creation; `rescueVaultSurplus` pass-through | `a809135` |
| PSR-10 | Low | No pause short of the one-way `finalize` | `setPaused` | `a809135` |
| PSR-11 | Low | The presale admin is immutable, while the spec said it would later move to the Safe | The deploy script refuses a mainnet admin with no code; spec corrected | `a809135` |
| PSR-04 | Medium (operational) | Contract defaults block the ETH/BNB path (5-minute staleness against an hourly heartbeat) and leave price bounds off | Deploy script sets staleness, bounds, stablecoin feeds and the minimum, checking each feed's on-chain description | `a809135` |
| PSR-12 | Info | Price views skipped the checks (a negative answer read as 2²⁵⁶−1); a future `updatedAt` panicked; staleness unbounded; stablecoins credited above par; USDT credited at nominal | One validated feed reader; 25h staleness cap; par cap; balance-delta crediting | `a809135` |
| PSR-13 | Info | Operator instructions told the admin to call a locked setter | Corrected | `a809135` |
| G-I1 / G-I2 | Info | Vault rescues and fee-limit changes emitted nothing | `DonatedTokensRescued`, `FeeLimitsUpdated` | this sweep's final commit |
| DEP-01 | High (deployment) | The deploy suite sent admin-only calls from the deployer, which reverts once the admin is the Safe — and the only workaround was to make the deployer the admin while genesis minted 10B SRX | `scripts/deploy/lib/adminTx.js`: an admin-only call executes directly when the signer is the admin (testnets) and is otherwise written to a Safe Transaction Builder batch. Scripts 03, 05, 05b, 06, 07, 08 and 09 converted; 08 no longer grants the deployer a temporary governance role; 06 queues genesis, distribution and the vault triggers, then stops until the Safe has executed them. Tested by `test/deploy/adminTx.test.js` (a queued call executed by the admin takes effect) and by `TgeDestinationControls.test.js`, which now requires every TGE call to go through the batch. ⚠️ Not yet rehearsed end to end on a live testnet deployment | this sweep's final commit |
| DEP-02 | Medium (deployment) | `02_deploy_governance.js` granted Timelock roles from the deployer, which is not the Timelock's admin — it reverts on any real deployment | Governor named as proposer in the Timelock constructor by predicted address; the script refuses a wrong prediction | `8507136` |

### ⚠️ Open or accepted — for the auditor's attention

- **PSR-03 — decision pending (Jared).** The presale hard cap is per contract, so
  a round on two chains is two caps, and the SRX that funds the round has no
  scripted source on mainnet. To be settled before deployment: which chain(s)
  carry the Genesis round, and where its 300M SRX comes from.
- **SPOKE-01 — open.** No Timelock is deployed on the spoke chains, so spoke
  owner actions are not delayed. Bounded by N-01: the hub never re-credits more
  than it sent to a chain. See `MULTISIG_SPEC.md`.
- **PSR-09 — operational.** Deploy presale vaults before `maxWalletBalance` is
  switched on; a new vault cannot be exempted in advance. In the deploy script
  and the spec's mainnet blocker list.
- **STK-L1 — fresh deployment required.** New staking and fund state was
  appended above the storage gaps, but neither contract has a reinitializer.
  Upgrading a proxy that already holds positions would start the new liability
  counters at zero beside real accruals. No proxy holds real value today; mainnet
  deploys fresh proxies.
- **SSF-L1 — accepted.** A 1-wei contribution keeps `totalContributions` above
  zero and so blocks `rescueStrandedPool`. The underlying behaviour — a sole
  contributor collects the whole stream — is inherent to the reward model at
  any size, so a minimum would not remove it. Mitigation: governance sets the
  reward rate to zero while the fund is idle.
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

✅ **The first 20 are merged to `main` (`d0fc8d5`).** The final three fixes and
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
| F5 | A **1-wei** position collected the entire emission stream — 1,166,400 SRX in a day — and blocked `rescueStrandedPool()` | `minStakeAmount` of 100 SRX |
| F6 | `addToPosition(x, 0)` added capital at 2.00× on an expired lock | ⛔ **Not fixed on 10 Sep** — its test asserted the bug. Fixed 23 Sep in `44e505e`; see the correction above |
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

- **B — bridged tokens bypass launch protection.** `SRXToken.sol:82-88` requires
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
all. ⛔ **It cannot be fixed by exempting the sender:** `SRXToken.sol:82-88`
*requires* DEX pool addresses to be exempt, so that change would let every
purchase from the pool bypass the cap and defeat launch protection outright — a
worse outcome than the bug. `scripts/ops/verify_tge.js` now **fails** if any
beneficiary's releasable amount would breach the cap, turning a silent deadlock
into a caught misconfiguration.

**F4 — by design, once F3 landed.** `unlock()` and `claimRewards()` are
`whenNotPaused`, so during a pause `earlyWithdraw` is the only exit. Since F3, an
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
