# SRX Token — Incident Response Playbook

## Severity Definitions

| Severity | Definition | Examples |
|---|---|---|
| **SEV-1** | Active exploit or imminent loss of funds | Reentrancy draining contracts, unauthorized role grant, bridge manipulation |
| **SEV-2** | Protocol malfunction affecting users | Token transfers paused unexpectedly, oracle failure, presale accepting wrong prices |
| **SEV-3** | Degraded functionality, no immediate fund risk | UI down, RPC errors, slow oracle updates |
| **SEV-4** | Informational, no user impact | Unusual on-chain activity with no confirmed exploit |

---

## Response Team

| Role | Responsibility |
|---|---|
| **Incident Commander** | Founder — owns the incident end-to-end |
| **Technical Lead** | CTO — leads technical diagnosis and fix |
| **Comms Lead** | Founder or designated — manages external communication |
| **Safe Signer 1–5** | Available for emergency multisig transactions |

All SEV-1 and SEV-2 incidents require the Incident Commander to be active
within 15 minutes of the first alert.

---

## SEV-1 Playbook — Active Exploit

### Immediate actions (first 15 minutes)

1. **Confirm the exploit** — Check on-chain data (Etherscan, Tenderly).
   Do not act on unconfirmed reports.

2. **Pause the token** — Assemble 3 Safe signers immediately. Who can pause depends on
   whether the launch hand-over has happened (`MULTISIG_SPEC.md`):
   ```
   After the hand-over (the launch state): the Safe does NOT hold PAUSER_ROLE on SRXToken.
   The guardian pauses through GuardianModule:
     GuardianModule.pauseModule(MODULE_TOKEN, "reason")   (one module; pauseModule cannot pause
                                                           the same module again within 1 hour)
     GuardianModule.pauseAll("reason")                    (every registered module; 30 minutes
                                                           between uses; it ignores the 1-hour
                                                           per-module wait, on purpose)
   Before the hand-over (testnets, rehearsals): Safe tx SRXToken.pause()
   ```
   This halts all transfers, bridging and staking deposits, and also burns, migrations and
   buybacks: a burn is a token movement too. That is intended (external disclosure C,
   4 Oct 2026). Admin controls, such as `setPeer` and the per-chain freeze below, keep working
   while paused. **One thing keeps moving** (Security ruling, 12 Oct 2026): exit-only
   withdrawals from a wound-down SRXStaking or StabilisationFund (holders get their own deposit
   back but cannot transfer it on).

   ⏱ **A guardian token pause lasts at most 14 days.** After that anyone may call
   `GuardianModule.lapseTokenPause()`, and the guardian cannot pause the token again for
   7 days. Pauses less than 7 days apart count as one run of at most 14 days, so unpausing
   and re-pausing does not buy more time. Guardian token pauses total at most 30 days. **If
   the exploit needs a longer pause, start a governance proposal for
   `governanceHoldTokenPause("reason")` on day 1**: a vote takes about 10 days (1-day delay,
   7-day vote, 48-hour queue), so it must start early. Once governance holds a pause, only
   governance can lift it: the guardian cannot. After the guardian's sunset, anyone may lift
   a pause the guardian left on any module (`releaseAfterSunset(moduleId)`); a pause that is
   governance's stays governance's.

   🌉 **Bridge only?** If the problem is confined to the bridge, stop the bridge and nothing
   else: `GuardianModule.pauseModule(MODULE_BRIDGE, "reason")` (sends and returns stop;
   ordinary transfers continue; a refused return can be retried later). This is what the
   circuit breaker does on its own when it trips; only governance reopens after a trip.

3. **Pause all other contracts** — If exploit spans multiple contracts:
   ```
   After the hand-over: GuardianModule.pauseModule(<module>, "reason") for each, or pauseAll
   Before the hand-over: Safe tx: each affected contract .pause()
   ```

4. **Revoke compromised roles** — If an admin key is compromised:
   ```
   Before the hand-over: Safe tx: contract.revokeRole(role, compromisedAddress)
   After the hand-over: the core contracts' roles are held by the Timelock, so a revoke is a
   Governor proposal plus the 48-hour delay. The Safe's powers are the emergency pause (through
   GuardianModule) and a veto: it can cancel a scheduled Timelock operation but not start one.
   ```
   Grant role to a fresh address if needed. Operational contracts the Safe administers
   (BuybackBurner, SRXAirdrop, PreSaleRound) can be revoked with a Safe tx.

5. **Freeze returns from the affected chain** — If the LayerZero bridge is involved. This is the fastest and
   most targeted step: it stops one chain sending SRX back to Ethereum, and leaves everything else running.
   ```
   Guardian multisig tx: GuardianModule.freezeBridgeInbound(chainEid, "reason")
   (before the launch hand-over: Safe tx SRXToken.freezeInbound(chainEid))
   ```
   Only governance lifts it (`SRXToken.unfreezeInbound`, a Timelock proposal). The hub's limit for a chain
   (`SRXToken.inboundLimit`) is a draining bucket: at most that much can be in flight at any moment,
   and it refills at that amount per 24 hours. A compromised chain could therefore bring back the
   limit at once, plus one more limit's worth for each day that passes before the freeze, so act
   quickly. After the freeze it can bring back nothing.
   To stop the chain entirely, also pause it (`SRXOFTNative.pause()`, fast). ⚠️ Open: internal
   audit M4 (design pending): the spoke pause is held by the Safe directly, has none of the hub's
   time limits, and the spoke's Timelock cannot lift it. A spoke's peers and DVN
   configuration are behind that chain's own 48-hour Timelock (SPOKE-01), so `setPeer(hubEid, bytes32(0))`
   on a spoke is a Timelock proposal, not an instant Safe action. On the hub, after the hand-over the
   owner is the Timelock, so setting a spoke's peer to zero there is also a 48-hour proposal.
   SRX or another token stranded at a spoke's own address is recovered by that spoke's Timelock
   (`SRXOFTNative.rescueTokens`, a 48-hour proposal).

6. **Notify LayerZero** — Contact security@layerzero.network immediately
   if the exploit involves the bridge layer.

### Containment (15 minutes – 2 hours)

7. **Quantify the damage** — Total funds at risk, funds already drained,
   affected users.

8. **Preserve evidence** — Save all transaction hashes, block numbers,
   attacker addresses. Do not wipe any logs.

9. **Draft user communication** — Acknowledge the incident publicly.
   Do NOT disclose exploit details until contained.
   Template: *"We are investigating unusual activity on the SRX protocol.
   Token transfers have been temporarily paused as a precaution.
   Funds are being assessed. Update in 1 hour."*

10. **Engage external incident support** — If an external security firm is under
    contract at that time, contact them. **No firm is on retainer for incident support at present**, so if one
    is needed the CTO appoints it as part of the response.

### Recovery (2 hours onwards)

> REG-53 (12 Oct 2026): the staking and fee-path contracts are not upgradeable. Recovery is
> pause, then (if code must change) wind-down and an opt-in new version. Security's procedure,
> with Compliance's wording rules (bus ce7dcf2, 424a270).

11. **Root cause analysis.** Identify the exact vulnerability and which contracts it touches.

12. **Decide the remedy.** SRXStaking, FeeController, StabilisationFund and SRXTreasury cannot be
    changed in place (REG-53); see `docs/CONTRACTS.md`.
    - **(a) A setting closes it** (a parameter, a fee destination, a limit). Make the change through
      its normal route (the Timelock, or the Safe for operational contracts), test it on a testnet
      fork first, then go to step 15.
    - **(b) Only new code closes it.** Go to step 13. **Never** an in-place upgrade; none is possible
      for these contracts.

13. **Wind down the affected contract.** ⛔ **The 30-day rule:** once SRXStaking or the
    StabilisationFund has been paused for a total of 30 days within one run of pauses, **anyone**
    may switch that contract to exit-only. Pauses less than 7 days apart are one run and only time
    actually paused counts, so lifting the pause for a moment and pausing again does not buy more
    time. Monitoring alerts at 21 days of pause in the run; decide before 30 (lift the pause, or
    wind down deliberately and announce it).
    - Lift the SRXToken pause if it is on (the affected module stays paused): a token-wide pause
      stops every transfer, withdrawals included.
    - Switch the contract to wind-down (`startWindDown()`: the Safe via WIND_DOWN_ROLE, or the
      Timelock). It is one-way: no new deposits, and every holder can take back their own principal
      with `exitAfterWindDown()`, with no penalty and no lock wait, even while it stays paused.
      Rewards accrued up to the switch stay claimable.
    - **Solvency check before announcing:** confirm the contract's SRX balance ≥ the sum of all
      holders' principal (staking: `totalLocked`; fund: `totalContributions`) plus owed rewards.
      Solvent: use **template A**. Not solvent: use **template B**, drafted on the day with
      Compliance; no reimbursement is promised unless Jared approves it.
    - **Nobody's tokens are moved for them.** The contract stays open for exits indefinitely: no
      deadline, and no sweep of unclaimed principal.

14. **Release a new version, opt-in** (`docs/MIGRATION.md`).
    - Write the fixed contract. A second reviewer is mandatory, and the external audit is required
      before mainnet. Deploy it fresh (also non-upgradeable).
    - Test the full exit-and-re-enter path on a testnet first.
    - Holders **choose** to exit the old version and deposit into the new one. Offer no incentive
      to move (no bonus, no boosted rewards).
    - Integrations (gateway fee routing, the /srx hub, `docs/ADDRESSES.md`) point new deposits at
      the new version.
    - For contracts **without user deposits** (FeeController, SRXTreasury): repoint fee routing to
      the new contract, and move protocol-owned funds only through their existing governance
      functions (the Timelock).

15. **Unpause gradually** (case a only). Unpause one module at a time and monitor for 30 minutes
    between each. A contract in wind-down is **never** reopened for deposits (no function can).

16. **Post-mortem.** Write a full post-mortem within 72 hours and publish it (see `SECURITY.md`).

---

## Communication Templates

### Initial alert (post within 15 minutes of SEV-1/SEV-2 confirmation)
> We are aware of an issue affecting [component]. Our team is actively
> investigating. Token transfers have been [paused/not affected].
> We will provide an update within [timeframe]. User funds are [status].

### Exit-only notice (step 13): template A, only after the solvency check passes
> We found an issue in <contract>. It has been paused and switched to exit-only. Your SRX remains
> yours: from <date, time UTC> you can withdraw your full deposit, with no penalty and no
> deadline. Rewards you had accrued up to the switch remain claimable. A new version is available
> at <address>; moving to it is your choice. Nothing moves unless you move it.

### Exit-only notice: template B, if the contract no longer holds every deposit (shape only)
> We found an issue in <contract>. It has been paused and switched to exit-only. <Amount> of
> deposited SRX was affected. Withdrawals open from <time UTC>; <what each depositor can withdraw
> now, and what Syrax will do about the shortfall>. Nothing moves unless you move it.

The exact text of B is drafted on the day with Compliance. Never "your SRX is safe" in either
template, never "at any time" (a token-wide pause stops withdrawals), never a reimbursement
promise without Jared's approval, and never an incentive to move to the new version (Compliance,
bus 424a270).

### Resolved notice
> The issue affecting [component] has been resolved. [Brief explanation
> of what happened and what was fixed]. A full post-mortem will be
> published within 72 hours. Thank you for your patience.

---

## Incident Register

All incidents must be logged here, regardless of severity.

| Date | Severity | Summary | Status | Post-mortem |
|---|---|---|---|---|
| — | — | No incidents recorded | — | — |

---

## Post-Mortem Template

Every SEV-1 and SEV-2 must produce a post-mortem published publicly.

```
Title: [Date] SRX Token Incident Post-Mortem
Severity: SEV-X
Date/time: UTC
Duration: X hours

Summary:
[2-3 sentence summary of what happened]

Timeline:
- HH:MM UTC — Alert triggered
- HH:MM UTC — Team assembled
- HH:MM UTC — Root cause identified
- HH:MM UTC — Fix deployed
- HH:MM UTC — Services restored

Root Cause:
[Technical explanation]

Impact:
[Funds at risk, users affected, duration]

Resolution:
[What was done to fix it]

Prevention:
[What changes prevent recurrence]
```

---

## Emergency Contacts

| Contact | Purpose |
|---|---|
| security@layerzero.network | LayerZero bridge issues |
| External security firm (none on retainer at present) | Emergency incident support |
| OpenZeppelin Defender support | Monitoring platform issues |
| Chainlink support | Oracle feed issues |

---

## Pre-Mainnet Checklist

- [ ] All team members have read this playbook
- [ ] Safe signing flow tested with all 5 signers
- [ ] The pause transaction pre-staged for 1-click execution (`GuardianModule.pauseModule` / `pauseAll`
      after the hand-over)
- [ ] Emergency contact list verified and current
- [ ] Incident communication channels confirmed (Twitter/X, Discord, Telegram)
- [ ] Post-mortem template shared with comms lead
- [ ] Wind-down rehearsal on a testnet: pause, wind down, every test wallet exits with exactly its
      principal (REG-53)
- [ ] A new-version deploy-and-migrate rehearsal on a testnet (`docs/MIGRATION.md`)
- [x] Exit-only templates A and B approved by Compliance (bus 424a270, 12 Oct 2026)
