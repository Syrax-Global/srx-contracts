# SRX pre-external-audit remediation

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
| F6 | `addToPosition(x, 0)` added capital at 2.00× on an expired lock | Weight decays to principal |
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
