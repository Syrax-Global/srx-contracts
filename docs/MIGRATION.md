# Changing an SRX contract: wind-down and opt-in migration

**Decision REG-53 (12 October 2026).** SRXStaking, FeeController, StabilisationFund and SRXTreasury
are plain contracts. Their code can never change, and no role can upgrade or replace them. No SRX
contract is upgradeable. Parameters can still be changed through their normal roles (governance
through the 48-hour Timelock); only the code is fixed.

So a code fix never happens in place. It ships as a new contract that holders **choose** to move
to. This document is the procedure. The incident playbook (`INCIDENT_RESPONSE.md`, Recovery) says
when to use it.

## 1. Contracts that hold holders' SRX: SRXStaking and StabilisationFund

These two contracts are designed so that a holder's deposited SRX remains theirs: nothing moves
unless they move it.

**Wind-down (exit-only mode)**
- `startWindDown()` makes the contract exit-only, permanently. No function reverses it.
- Who can switch it on:
  - the Timelock (`GOVERNANCE_ROLE`);
  - the admin Safe (`WIND_DOWN_ROLE`, kept by the Safe after the launch hand-over, for speed);
  - **anyone**, once the contract has been paused for a total of 30 days within one run of pauses
    (`PAUSE_EXIT_DELAY`). Pauses less than 7 days apart (`PAUSE_BREAK`) are one run, and only time
    actually paused counts.
    This exists so that a pause can never become permanent confinement of
    holders' SRX. Monitoring alerts when 21 days of pause have built up in the run (`windDownOpenToAllAt()`).
- Switching on wind-down first reads the launch allocation, if it has not been read, so even a
  pool that never registered rewards can pass its unused allocation to a successor.
- Once on:
  - **no new deposits:** staking accepts no new locks or top-ups; the fund accepts no new
    contributions;
  - **no new rewards:** reward registrations and rate changes are refused, and emission stops;
  - **the fund's stress mode ends** and cannot be restarted;
  - **every holder can call `exitAfterWindDown()`.** It returns exactly their own principal, with
    no penalty and no lock wait, **even while the contract is paused**;
  - **earned rewards stay claimable:** rewards accrued up to the switch can still be claimed with
    `claimRewards()`, even while paused;
  - **no role can move a holder's principal.** Governance can still move only the fund's free
    SRX, never depositors' principal and never the SRX that backs rewards.
- **The token-wide pause still applies.** While `SRXToken` itself is paused, every transfer
  fails, withdrawals included. That pause is the short emergency brake, and the playbook lifts it
  before exits are expected.

**Migration, step by step**
1. **Pause** the affected contract through GuardianModule (the Safe).
2. **Decide the remedy.** If a parameter fixes it, change the parameter and stop here.
3. **Switch the old contract to wind-down.** Check its solvency first: its SRX balance must be at
   least the holders' total principal plus the rewards owed. Announce with template A (solvent)
   or B (shortfall) from `INCIDENT_RESPONSE.md`. The announcement states when withdrawals open, in
   UTC. It never says "at any time" and never promises reimbursement without Jared's approval.
4. **Build and deploy the new version.**
   - Write the fixed contract, with a second reviewer, the tests, the mutation proof and
     Slither.
   - The external audit is required before mainnet.
   - Deploy it fresh, non-upgradeable.
   - Rehearse the full exit-and-re-enter path on a testnet first.
5. **Give the new version its rewards.** The new contract is deployed with the **old contract as
   its allocation source**. The old contract refuses to release to anything else: not a wallet, and
   not a contract that names a different source. (There is no rescue function either: since
   16 Oct 2026, internal audit L1, `rescueStrandedPool` no longer exists, so this release is the
   only way the unused pool leaves.)
   - The Timelock calls `releaseRewardAllocation(newContract, amount)` on the old contract.
   - Only the reward allocation nobody has been promised can be released
     (`releasableRewardAllocation()`): launch SRX never registered, plus the part of the pool not
     yet accrued to anyone.
   - Holders' principal and rewards already owed can never be released. Neither can SRX that
     reached the old contract any other way: the amount is capped by the allocation records and
     by what the contract actually holds.
   - The old contract records the release and answers the new one exactly as the launch
     distributor did. So the new version's rewards are backed only by released launch
     allocation, never by fees (REG-50).
   - **Release before the new contract's first reward registration.** A registration counts only
     against backing already delivered. The new contract re-reads its backing until it winds
     down, and the backing only ever rises, so a stranger who reads it early cannot pin it at 0
     (internal audit M1, 16 Oct 2026).
6. **Holders choose.** Each holder exits the old contract and, if they want, deposits into the
   new one.
   - There is no incentive to move: no bonus and no boosted rewards.
   - The old contract stays open for exits indefinitely. It has no deadline, and unclaimed
     principal is never swept.
7. **Point integrations at the new version:**
   - the gateway's fee routing;
   - the /srx hub manifest;
   - `docs/ADDRESSES.md`;
   - the whitepaper and its change log, with the holder notice the Issuance Rulebook requires
     before a change takes effect.

## 2. Contracts without holders' deposits: FeeController and SRXTreasury

1. Deploy the new version, non-upgradeable, after review and audit.
2. **FeeController:** point the gateway's fee calculation and the routing table at the new
   contract.
3. **SRXTreasury:** move protocol-owned funds only through the existing governance functions
   (the Timelock and the spending role). No new path is created for the move.
4. Update the integrations, the addresses list and the whitepaper, as in step 7 above.

## 3. What never happens

- No in-place upgrade. The code cannot be changed.
- No forced migration. Nobody's SRX is moved for them.
- No deadline on exits from the old contract, and no sweep of unclaimed principal.
- No rewards funded from fees, at any version (REG-50).
