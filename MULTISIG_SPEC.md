# SRX Token — Gnosis Safe Multisig Specification

## Why a Multisig — and what it may and may not hold

At deployment the privileged roles are held by the admin Safe (the deploy scripts
pass it as admin) and never by the deployer EOA. One compromised private key
must never equal loss of protocol control, so the Safe is a 3-of-5.

⭐ **Delay-only at launch (decided 23 Sep 2026, pre-external-audit sweep GOV-H1).**
Before mainnet is considered ready, every administrative power over the core
contracts moves behind the **48-hour SRXTimelock**, whose only proposer is the
SRXGovernor. The admin Safe keeps exactly three powers on the core contracts:

- **emergency pause**, exercised through GuardianModule,
- **a veto** — `CANCELLER_ROLE` on the Timelock. It can stop a scheduled
  operation; it cannot start one, and
- **wind-down** — `WIND_DOWN_ROLE` on SRXStaking and StabilisationFund (REG-53). It can
  switch either contract, for good, to exit-only mode (no new deposits; each holder can take
  back exactly their own principal). It cannot move anyone's tokens, and it cannot undo the
  switch.

⚠️ Open: internal audit M4 (design pending). The statement above is the target for every
contract and holds on the hub. On each spoke (`SRXOFTNative`) the Safe still holds
`DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `BURN_ROLE` directly after the hand-over, which moves
only the spoke's `owner()` and LayerZero delegate. ⚠️ Open: internal audit M8 (design
pending): the veto can cancel the very operation that would remove it, so nothing on chain
ends it.

⛔ This replaces the earlier end state, in which the Safe kept `DEFAULT_ADMIN_ROLE`
on every contract. From there one Safe batch could grant itself `SPENDER_ROLE` and
withdraw the treasury, or use
the StabilisationFund's `GOVERNANCE_ROLE` to move all 1.5B SRX — none of it
delayed, although the documentation promised a 48-hour delay. As Timelock admin it
could also make itself a proposer and schedule `updateDelay(0)`.

---

## Safe Configuration

| Parameter | Value |
|---|---|
| Safe version | 1.4.1 (latest) |
| Threshold | 3 of 5 signers |
| Network | Ethereum mainnet (deploy Safe here first) |
| Cross-chain | Deploy matching Safe on BNB Chain for BNBChain roles |

### Signer Allocation (5 slots)

| Slot | Role | Custody |
|---|---|---|
| 1 | Founder | Hardware wallet (Ledger/Trezor) |
| 2 | CTO | Hardware wallet (Ledger/Trezor) |
| 3 | Legal/Compliance | Hardware wallet |
| 4 | Cold backup 1 | Hardware wallet, geographically separate |
| 5 | Cold backup 2 | Hardware wallet, geographically separate |

No signer should use a software wallet or hot wallet for Safe signing.
No two signers should share the same physical location.

---

## Launch role topology

Enforced by `scripts/verify/verify_roles.js` (the mainnet gate). Since 30 Sep 2026 it
covers every privileged contract:
- the core contracts below and **GuardianModule**: the roles in the gate's fixed matrix
  (`verify_roles.js`) are checked: the listed holders must hold each role, and the Safe or
  the deployer holding one of those roles when not listed is a failure. A role outside that
  matrix is not checked, and the gate cannot enumerate every holder of a role on chain;
- the operational contracts: the administrator is the Safe as listed, never the deployer;
  where a role sits with the Timelock (the migrator's `GOVERNANCE`) that is checked too;
- contracts with an **immutable `admin()`** (TGEDistributor, PreSaleRound, each launch
  VestingVault): never the deployer;
- a contract a network does not have must be **declared** `none`. An undeclared one fails;
- on a real network the deployer is pinned in `deploy/addresses.<net>.json` `roles.deployer`.

### Core contracts — everything behind the Timelock (gated)

| Contract | `DEFAULT_ADMIN` | `GOVERNANCE` | `SPENDER` | `PAUSER` | Other |
|---|---|---|---|---|---|
| SRXToken | Timelock | Timelock | — | GuardianModule | `BURN_ROLE`: contracts only (Treasury, Migrator, BuybackBurner), never the Safe. `owner()` and the LayerZero delegate: Timelock |
| SRXTimelock | Timelock itself | — | — | — | `PROPOSER`: Governor only. `CANCELLER`: Governor, and the Safe (veto). Delay floor: `updateDelay` below the deployment delay (48 h on mainnet) reverts `DelayBelowFloor` |
| SRXTreasury | Timelock | Timelock | Timelock | GuardianModule | Not upgradeable: plain contract (REG-53) |
| SRXStaking | Timelock | Timelock | — | GuardianModule | `WIND_DOWN_ROLE`: the admin Safe (kept after the hand-over; never the deployer). Not upgradeable: plain contract (REG-53) |
| FeeController | Timelock | Timelock | — | GuardianModule | `GATEWAY_ROLE`: defined but gates no function today (the backend only reads `calculateFee`); the deployer must not hold it. Not upgradeable: plain contract (REG-53) |
| StabilisationFund | Timelock | Timelock | — | GuardianModule | `DEPLOYER_ROLE` / `GUARDIAN_ROLE`: two distinct multisigs (bounded fast paths). `WIND_DOWN_ROLE`: the admin Safe (kept after the hand-over; never the deployer). Not upgradeable: plain contract (REG-53) |

⚠️ Open: internal audit M4 (design pending): "`BURN_ROLE`: contracts only, never the Safe" holds
on the hub. A spoke's admin, which is the Safe, keeps `BURN_ROLE` there.

Consequence, stated plainly: after the hand-over, **genesis, new `BURN_ROLE`
grants, LayerZero peers and DVN configuration, fee changes and every
treasury spend are Governor proposals with a 48-hour delay.** Do every launch
wiring step that needs an admin *before* phase 2 of the migration.

### Operational contracts — Safe-administered by design (not gated)

These run day-to-day operations where a 48-hour delay would stop the product
working. Each is listed with what its administrator can reach, because that is
the trust assumption an investor or auditor is being asked to accept.

| Contract | Administrator | What the administrator can reach |
|---|---|---|
| PreSaleRound | Safe (immutable `admin`) | The raised funds, **minus every refund owed** (ring-fenced, PSR-06); the SRX no buyer is owed (`recoverSRX` takes only the surplus above `pendingDeployment()`, so buyers' SRX is ring-fenced like their refunds; internal audit L6, 16 Oct 2026); `revokeVault` on any investor. It cannot change the price while any investor exists (the lock follows the live investor list, so it reopens only if every investor has been refunded or removed), or remove a paying investor without refunding them. ⚠️ Open: internal audit M3 (design pending): once a buyer's vault exists, `revokeVault` can remove a paying buyer with no refund, because `refundInvestor` refuses after that point. **SC-TRUST-004**: disclosed custodial-presale trust. On mainnet the deploy script refuses an admin with no code (PSR-11) |
| BuybackBurner | Safe (`DEFAULT_ADMIN`), executor key (`EXECUTOR_ROLE`) | Only what is sent to the burner. Every swap is capped per token, per swap and per 24 hours; a token with no caps cannot be swapped; approvals are exact and reset (BB-M2) |
| SRXAirdrop | Safe | The SRX loaded into the current round, recoverable only after its deadline; a live round lasts at least 7 days and its deadline cannot move earlier (N-06) |
| ZkSyncMigrator | Timelock (`DEFAULT_ADMIN` after the hand-over, and `GOVERNANCE`), oracle (`ORACLE_ROLE`) | Migration settlement records; the SRX it burns comes only from the migrating user. ⭐ Jared, 30 Sep: its admin moved behind the delay (as admin the Safe could have granted itself `GOVERNANCE` and opened migration at once). **Gated** |
| VestingVault | Launch vaults: **the Timelock** (immutable, set by `03_deploy_vesting`). Presale buyer vaults: PreSaleRound (SC-TRUST-004) | `triggerTGE`, `revoke`, and surplus rescue above the declared grant (PSR-08). ⭐ Jared, 30 Sep: `revoke` sends a vault's whole unvested remainder anywhere, so for the launch vaults it is a 48-hour governance proposal, never a Safe power. ⚠️ Open: internal audit M2 (design pending): the recipient is a parameter and can be the beneficiary, which makes a whole locked grant liquid. Grant declaration and the clock start are scheduled Timelock operations (see TGE_DEPLOYMENT_RUNBOOK). **Gated**: any other admin fails |
| GuardianModule | Safe (guardian), Timelock (`GOVERNANCE`, and `DEFAULT_ADMIN` after the hand-over) | Pause only, bounded: a guardian token pause lasts at most 14 days (then anyone may lift it), is followed by a 7-day block after a full term, and totals at most 30 days; pauses less than 7 days apart count as one 14-day run, so unpausing a moment early buys nothing (M7); the guardian's life is at most 180 days (constructor). A token pause that governance holds, or an outside pause that `pauseAll` adopted, can be lifted only by governance (M12), and after the sunset anyone may lift a pause the guardian left (`releaseAfterSunset`, L15). `pauseAll` ignores the per-module one-hour wait by design. The circuit breaker stops the bridge only, never ordinary transfers (12 Oct 2026). The guardian cannot re-open a tripped circuit breaker (G-L1). ⛔ Until 30 Sep the Safe kept `DEFAULT_ADMIN` here and could grant itself `GOVERNANCE` — now handed over by `migrate_roles.js` and **gated** |
| SRXOFTNative (spokes) | **That chain's own SRXTimelock** (48 h; the Safe proposes and can cancel, anyone executes, no admin), as `owner()` (Ownable2Step) **and** LayerZero delegate. Pausing stays fast (`PAUSER_ROLE`) | Peers, enforced options, DVN/library configuration and `rescueTokens` (SRX or any token stranded at the spoke's own address; plain transfers to that address are refused) on that chain. ⚠️ Open: internal audit M4 (design pending): "Pausing stays fast" is also unbounded. The spoke pause is held by the Safe directly and has none of the hub's limits (no maximum duration, lapse, sunset or governance override), and the spoke's Timelock cannot lift it. The only peer it accepts is the hub, at the address fixed at deployment, or zero. ⛔ **Corrected 7 Oct 2026 (external disclosure A):** this row used to say a bad spoke configuration "cannot mint unbacked SRX back onto Ethereum". **That was false.** The hub's ledger (N-01) cannot tell real SRX from forged, so a compromised spoke owner or delegate could return everything ever sent to that chain. **SPOKE-01 is now closed:** the spoke's authority is behind its Timelock (`07_deploy_bridge.js` steps D–E, checked by `verify_spoke.js`), and the hub accepts each chain's returns only up to a limit (a draining bucket: at most that much in flight, refilling at that amount per 24 hours; none set means no returns), which the guardian can freeze per chain (`SRXToken.inboundLimit`, `GuardianModule.freezeBridgeInbound`). **Gated** |

---

## Hand-over procedure

### Step 1 — Deploy the Safe

Use the Gnosis Safe web app (app.safe.global) or CLI:
```
Network: Ethereum Mainnet
Owners: [addr1, addr2, addr3, addr4, addr5]
Threshold: 3
```

Record the Safe address in `TGE_DEPLOYMENT_RUNBOOK.md`, and set it as
`ADMIN_ADDRESS` before running any deploy script.

### Step 2 — Deploy and wire

Run the deploy scripts. The deployer EOA never holds a role: every constructor
names the Safe (or the Timelock) directly, and
`02_deploy_governance.js` names the Governor as Timelock proposer in the
Timelock's constructor. Finish every step that needs an admin — genesis,
`BURN_ROLE` grants, bridge peers, DVN configuration, the presale launch
configuration — before Step 3's phase 2.

### Step 3 — Migrate to the launch topology

`scripts/ops/migrate_roles.js` computes the minimal set of operations and is
idempotent (steps already correct on-chain are skipped). It has two phases,
because the token's two-step ownership transfer needs the Timelock to accept:

```
# Phase 1 — NOT freely reversible. Grants to the Timelock, GuardianModule and Governor; the
# Safe gives up GOVERNANCE, SPENDER, PAUSER and BURN (it keeps WIND_DOWN_ROLE on SRXStaking and
# StabilisationFund; there is no UPGRADER_ROLE to move); token delegate + ownership transfer; the
# Timelock's acceptance of ownership is scheduled. Revoking the Safe's SPENDER_ROLE cannot be
# undone by the Safe: SPENDER_ROLE administers itself, so putting it back needs a Timelock operation.
npm run migrate:roles -- --network ethereum
# → migrate_roles.phase1.ethereum.json; import at app.safe.global → Transaction Builder

# Wait the Timelock delay (48 hours on mainnet).

# Phase 2 — IRREVERSIBLE. Executes the acceptance, then the Safe removes its own
# admin rights, the Timelock admin last. Refuses to run before the delay has passed.
# ⚠️ Open: internal audit M11 (design half pending). The Safe is a temporary Timelock
# proposer from step 03 until phase 2, and an operation it schedules in that window survives
# phase 2. The gate half of the fix (verify_roles fails on pending pre-hand-over Timelock
# operations) is being built.
MIGRATE_FINALIZE=1 npm run migrate:roles -- --network ethereum
```

Testnet or fork rehearsal: add `MIGRATE_EXECUTE=1` to execute directly from the
loaded signer. The whole sequence is rehearsed end to end, against a throwaway
local chain, by `scripts/ops/rehearse_role_migration.js`. It requires:
- the gate to FAIL on the as-deployed topology;
- phase 2 to refuse before the delay;
- the gate to pass afterwards;
- a re-run to be a no-op.

### Step 4 — Verify

```
npm run verify:roles -- --network ethereum
```
This MUST print `✅ ALL CHECKS PASSED` before mainnet is considered ready. Set
`DEPLOYER_EOA`, `DEPLOYER_MULTISIG` and `GUARDIAN_MULTISIG`, or the run reports
itself INCOMPLETE rather than passing.

### Step 5 — Test a Safe transaction

Execute a low-risk Safe transaction (e.g. a pause and unpause through
GuardianModule on testnet) to confirm the 3/5 signing flow works before relying
on it in production.

---

## Operational Signing Policy

| Action | Who |
|---|---|
| Emergency pause | Safe, 3 of 5, via GuardianModule |
| Start wind-down (exit-only mode) on SRXStaking or StabilisationFund | Safe, 3 of 5 (`WIND_DOWN_ROLE`). Irreversible; also open to the Timelock, and to anyone once the contract has been paused for a total of 30 days within one run of pauses (pauses less than 7 days apart are one run, and only time actually paused counts; L2) |
| Cancel a scheduled Timelock operation (veto) | Safe, 3 of 5 |
| Grant/revoke any core role, treasury spend, fee change, peer change | Governor proposal → Timelock, 48 h |
| Presale, airdrop, buyback caps, migrator operations | Safe, 3 of 5 |
| Change presale oracle bounds or staleness | Safe, 3 of 5 |

---

## Mainnet Blocker

The following must be true before `v1.0.0` is deployed:

- [ ] Gnosis Safe deployed and signer keys verified
- [ ] 3/5 test transaction executed successfully
- [ ] Every admin-dependent launch step done (genesis, `BURN_ROLE`, peers, DVNs)
- [ ] `migrate_roles.js` phase 1 executed, delay elapsed, phase 2 executed
- [ ] `npm run verify:roles` prints `✅ ALL CHECKS PASSED`, with no INCOMPLETE advisories (SC-TRUST-001/002)
- [ ] On-chain verification complete (Etherscan role checks)
- [ ] PreSaleRound deployed with the Safe as admin, and its launch configuration (`presale_config.<net>.json`, PSR-04) executed before the round opens
- [ ] PreSaleRound `srxPriceUsd8Dec` set to the final value BEFORE the first investor is recorded (R5-02 — price locks on first investor)
- [ ] Presale vaults deployed BEFORE SRXToken `maxWalletBalance` is switched on (PSR-09)
- [ ] Safe address recorded in `TGE_DEPLOYMENT_RUNBOOK.md`
