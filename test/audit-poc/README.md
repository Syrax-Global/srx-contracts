# Vulnerability proofs-of-concept

⛔ **THESE TESTS ASSERT THAT THE CODE IS CURRENTLY BROKEN.**

They pass **because** the vulnerabilities are present. When a defect is fixed,
its test will start FAILING — that is the intended signal, not a regression.
Invert or delete the specific assertion as part of the fix, in the same commit,
so the suite never sits green on a bug that has been fixed and re-introduced.

Run them:

    npx hardhat test test/audit-poc/*.test.js

**31 passing** as of `b6d5e6a` (9 Sep 2026). Every one deploys the real
contracts against local mocks — no network, no forking.

⭐ **Why these exist.** The pre-audit sweep produced 123 written findings, and a
written finding is a hypothesis. These are the subset that could be reduced to
executable proof. "The scanner says X" is a finding; "here is a test that makes
the contract do X" is not arguable. Where a claim could not be made to execute,
it is not in this directory.

---

## What each file proves

### `bridge-supply-cap.test.js` — the worst of them

| | |
|---|---|
| **A** | The origin `SRXToken` **mints past `MAX_SUPPLY`** on an inbound LayerZero credit. Measured: `totalSupply` reaches `2e28` against a `MAX_SUPPLY` of `1e28`. **The supply cap is not enforced on the mint path.** |
| **B** | An inbound credit bypasses `maxWalletBalance` / `maxTransferAmount` entirely — launch protection does not apply to bridged tokens. |
| **C** | `setPeer` reverts while paused, so the peer-freeze step in `INCIDENT_RESPONSE.md` **cannot be executed during the incident it is written for.** |
| **D** | `setDelegate` is **not** pause-guarded, though `setPeer` is. |
| **E** | The remote `SRXOFTNative` mints with no supply cap either. |

### `staking-economics.test.js`

| | |
|---|---|
| **F1 / F1b** | `setRewardRate` and `notifyRewardAmount` both over-extend `periodFinish`, so promised emission exceeds the funded pool (`earned 1912` against `pool 1010`). The last claimer is silently shorted and `pendingRewards` is zeroed. |
| **F2** | The 2.00× lock multiplier **survives lock expiry** — permanent 2× weight at zero commitment. |
| **F3** | `earlyWithdraw` charges the 10% penalty even on a lock that has **already expired**. |
| **F4** | While paused, `earlyWithdraw` is the only exit — so exiting during a pause always costs 10%. |
| **F5** | ⭐ With emissions live and no other stakers, a **1-wei position collects 100% of emissions**: 1,166,400 SRX in one day. It also blocks `rescueStrandedPool()`. |
| **F6 / F6b** | `addToPosition(x, 0)` adds capital at 2.00× weight while staying fully liquid; a 1-wei 180-day seed lock mints a permanent 2× slot. |

### `vesting-and-distribution.test.js`

| | |
|---|---|
| **V1** | ⭐ Repeated `release()` **drains the full founder allocation at the vesting midpoint** — 999,855 of 1,000,000 extracted in 9 calls where the schedule allows 500,456. |
| **V2** | A presale vault yields **33% at the TGE instant**, not the 25% `tgeUnlockBps` specifies. |
| **V3** | `totalAllocation()` grows on every claim (1,000,000 → 1,250,000) — the double-count that drives V1. |
| **V4** | `revoke()` is bricked once the beneficiary has drained via repeated `release()`. |
| **V5** | A pre-TGE donation is vested **to the beneficiary**, not returned. |
| **V6** | `release()` is fully blocked by `maxWalletBalance` even with the vault exempt — beneficiaries cannot claim at all at TGE. |
| **V7** | One prior `release()` diverts unvested tokens from the treasury to the beneficiary: beneficiary 960,000 against a schedule of ~600,000; treasury 39,999 against ~400,000. |
| **TGE** | ⭐ `distribute()` succeeds with an **empty allocation set**, burns the one-shot flag, and permits the whole **10,000,000,000 SRX** to be swept to a single address. |

### `migration-replay.test.js`

| | |
|---|---|
| **1** | The deploy script leaves the admin EOA holding `GOVERNANCE_ROLE` alongside the Timelock. |
| **2** | `migrate()` **reverts on a fresh deployment** — `09_deploy_migrator.js` never grants the migrator `BURN_ROLE`. |
| **3** | ⭐ Two chain deployments emit **byte-identical `MigrationRequest` payloads** — no domain separator, so a signed request is replayable across chains. |
| **4** | SRX sent directly to the migrator is permanently unrecoverable — no rescue function exists. |
| **5** | A stranded balance plus `maxWalletBalance` bricks `migrate()` for everyone. |

### `token-standard-and-governance.test.js`

| | |
|---|---|
| **T1** | A **zero-value transfer reverts** when the recipient is over `maxWalletBalance` — an ERC-20 conformance violation. |
| **T2** | Exempting a DEX pool (which `SRXToken.sol:86` requires) **disables `maxTransferAmount` for every trade** — the launch protection is defeated by its own required configuration. |
| **T3** | ⭐ Governance **quorum falls 1:1 with SRX bridged off Ethereum**: 400,000,000 at 10B, 160,000,000 at 4B. Bridging tokens away lowers the bar to pass a proposal. |
| **T4** | A `permit()` consumes the nonce a pre-signed `delegateBySig` needs. |
| **T5** | ✅ **Not a defect.** Self-transfer, clock mode and the permit domain are conformant. Kept so the file records what was checked and found correct. |
