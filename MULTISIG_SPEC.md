# SRX Token — Gnosis Safe Multisig Specification

## Why a Multisig — and what it may and may not hold

At deployment the privileged roles are held by the admin Safe (the deploy scripts
pass it as admin) and never by the deployer EOA. One compromised private key
must never equal loss of protocol control, so the Safe is a 3-of-5.

⭐ **Delay-only at launch (decided 23 Sep 2026, pre-external-audit sweep GOV-H1).**
Before mainnet is considered ready, every administrative power over the core
contracts moves behind the **48-hour SRXTimelock**, whose only proposer is the
SRXGovernor. The admin Safe keeps exactly two powers on the core contracts:

- **emergency pause**, exercised through GuardianModule, and
- **a veto** — `CANCELLER_ROLE` on the Timelock. It can stop a scheduled
  operation; it cannot start one.

⛔ This replaces the earlier end state, in which the Safe kept `DEFAULT_ADMIN_ROLE`
on every contract. From there one Safe batch could grant itself `SPENDER_ROLE` and
withdraw the treasury, re-grant `UPGRADER_ROLE` and upgrade any contract, or use
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

Enforced by `scripts/verify/verify_roles.js` (the mainnet gate) for the six
contracts marked **gated**; the gate fails if any of these holders is wrong, and
fails if the Safe or the deployer holds any role it does not list.

### Core contracts — everything behind the Timelock (gated)

| Contract | `DEFAULT_ADMIN` | `GOVERNANCE` | `UPGRADER` | `SPENDER` | `PAUSER` | Other |
|---|---|---|---|---|---|---|
| SRXToken | Timelock | Timelock | — | — | GuardianModule | `BURN_ROLE`: contracts only (Treasury, Migrator, BuybackBurner), never the Safe. `owner()` and the LayerZero delegate: Timelock |
| SRXTimelock | Timelock itself | — | — | — | — | `PROPOSER`: Governor only. `CANCELLER`: Governor, and the Safe (veto) |
| SRXTreasury | Timelock | Timelock | Timelock | Timelock | GuardianModule | |
| SRXStaking | Timelock | Timelock | Timelock | — | GuardianModule | |
| FeeController | Timelock | Timelock | Timelock | — | GuardianModule | `GATEWAY_ROLE`: the Syrax backend |
| StabilisationFund | Timelock | Timelock | Timelock | — | GuardianModule | `DEPLOYER_ROLE` / `GUARDIAN_ROLE`: two distinct multisigs (bounded fast paths) |

Consequence, stated plainly: after the hand-over, **genesis, new `BURN_ROLE`
grants, LayerZero peers and DVN configuration, fee changes, upgrades and every
treasury spend are Governor proposals with a 48-hour delay.** Do every launch
wiring step that needs an admin *before* phase 2 of the migration.

### Operational contracts — Safe-administered by design (not gated)

These run day-to-day operations where a 48-hour delay would stop the product
working. Each is listed with what its administrator can reach, because that is
the trust assumption an investor or auditor is being asked to accept.

| Contract | Administrator | What the administrator can reach |
|---|---|---|
| PreSaleRound | Safe (immutable `admin`) | The raised funds, **minus every refund owed** (ring-fenced, PSR-06); undeployed SRX (`recoverSRX`); `revokeVault` on any investor. It cannot change the price once the first investor exists, or remove a paying investor without refunding them. **SC-TRUST-004**: disclosed custodial-presale trust. On mainnet the deploy script refuses an admin with no code (PSR-11) |
| BuybackBurner | Safe (`DEFAULT_ADMIN`), executor key (`EXECUTOR_ROLE`) | Only what is sent to the burner. Every swap is capped per token, per swap and per 24 hours; a token with no caps cannot be swapped; approvals are exact and reset (BB-M2) |
| SRXAirdrop | Safe | The SRX loaded into the current round, recoverable only after its deadline; a live round lasts at least 7 days and its deadline cannot move earlier (N-06) |
| ZkSyncMigrator | Safe (`DEFAULT_ADMIN`, `GOVERNANCE`), oracle (`ORACLE_ROLE`) | Migration settlement records; the SRX it burns comes only from the migrating user |
| VestingVault | Its creator (TGEDistributor or PreSaleRound) | `triggerTGE`, `revoke`, and surplus rescue above the declared grant (PSR-08) |
| GuardianModule | Safe (guardian), Timelock (`GOVERNANCE`) | Pause only. The guardian cannot re-open a tripped circuit breaker (G-L1) |
| SRXOFTNative (spokes) | The Safe on that chain, via `owner()` (Ownable2Step, cannot be renounced) | Peers and LayerZero configuration on that chain. ⚠️ **Open (SPOKE-01):** no Timelock is deployed on the spoke chains and `migrate_roles.js` covers the Ethereum hub only, so spoke configuration is not delayed. What bounds it: a spoke accepts messages from its hub only, and the hub re-credits a chain only up to what it sent there (N-01) — a bad spoke configuration can harm holders on that chain but cannot mint unbacked SRX back onto Ethereum |

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
and initializer names the Safe (or the Timelock) directly, and
`02_deploy_governance.js` names the Governor as Timelock proposer in the
Timelock's constructor. Finish every step that needs an admin — genesis,
`BURN_ROLE` grants, bridge peers, DVN configuration, the presale launch
configuration — before Step 3's phase 2.

### Step 3 — Migrate to the launch topology

`scripts/ops/migrate_roles.js` computes the minimal set of operations and is
idempotent (steps already correct on-chain are skipped). It has two phases,
because the token's two-step ownership transfer needs the Timelock to accept:

```
# Phase 1 — reversible. Grants to the Timelock, GuardianModule and Governor; the Safe
# gives up every operational role; token delegate + ownership transfer; the Timelock's
# acceptance of ownership is scheduled.
npm run migrate:roles -- --network ethereum
# → migrate_roles.phase1.ethereum.json; import at app.safe.global → Transaction Builder

# Wait the Timelock delay (48 hours on mainnet).

# Phase 2 — IRREVERSIBLE. Executes the acceptance, then the Safe removes its own
# admin rights, the Timelock admin last. Refuses to run before the delay has passed.
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
| Cancel a scheduled Timelock operation (veto) | Safe, 3 of 5 |
| Grant/revoke any core role, upgrade, treasury spend, fee change, peer change | Governor proposal → Timelock, 48 h |
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
