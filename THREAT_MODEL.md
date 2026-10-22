# SRX Token — Master Threat Model & Coverage Index

> The single navigable map of the **entire** SRX attack surface. Five contract-audit rounds
> (R1–R5) covered Domain 1 (Solidity correctness) and converged. Round 6 maps the other eleven
> domains — deployment, economics, bridge, governance, keys, oracle, supply-chain, legal,
> social, formal verification, and incident response.
>
> **Standing recommendation:** internal exhaustiveness (this document set) is what makes an
> external audit cheaper and faster — it is **not** a replacement for one. A named external
> audit remains the on-chain mainnet gate; exchanges,
> investors, and insurers require it, and it brings differently-tooled, independent, accountable
> review that same-lineage internal rounds structurally cannot.

---

## Coverage at a glance

| # | Domain | Status | Residual | Primary doc | Owner |
|---|--------|--------|----------|-------------|-------|
| D1 | Contract code correctness | ✅ internal rounds plus the 7 Oct 2026 external reports, all fixed with tests; the 16 Oct 2026 internal audit (12 Medium, 17 Low) fixed in part, the rest in progress or open for design decisions (see `REMEDIATION.md`) | Low | `docs/audits/`, `REMEDIATION.md` | Eng |
| D2 | Deployment & TGE execution | ✅ remediated R6 | Med | `DEPLOYMENT_SECURITY.md` | Eng/DevOps |
| D3 | Economic / tokenomics | 🟡 draft | High | `ECONOMIC_THREAT_MODEL.md` | Founder/Eng |
| D4 | Cross-chain / bridge | 🟡 draft | High | `BRIDGE_SECURITY_MODEL.md` | Eng |
| D5 | Governance / decentralization | 🟡 draft | Med | `GOVERNANCE_THREAT_MODEL.md` | Founder/Eng |
| D6 | Key management (human) | 🟡 draft | High | `KEY_MANAGEMENT_CEREMONY.md` | Founder |
| D7 | Oracle infrastructure | 🟡 draft | Med | `ORACLE_CONFIG.md` | Eng |
| D8 | Supply-chain / build | 🟡 draft | Med | `SUPPLY_CHAIN_SECURITY.md` | Eng/DevOps |
| D9 | Legal / regulatory | 🟡 draft (needs counsel) | High | `REGULATORY_THREAT_MODEL.md` | Legal/Founder |
| D10 | Post-launch / social | 🟡 draft | Med | `LAUNCH_DAY_PLAYBOOK.md` | Founder/Comms |
| D11 | Formal verification / coverage | 🟡 invariants in progress | Med | `test/foundry/invariant/` | Eng |
| D12 | Incident response realism | 🟡 draft | Med | `INCIDENT_WARGAME.md` | Eng/Founder |

⛔ **"🟡 draft" above means the named document HAS NOT BEEN WRITTEN.** Nine of the
twelve "Primary doc" entries — `ECONOMIC_THREAT_MODEL.md`,
`BRIDGE_SECURITY_MODEL.md`, `GOVERNANCE_THREAT_MODEL.md`,
`KEY_MANAGEMENT_CEREMONY.md`, `ORACLE_CONFIG.md`, `SUPPLY_CHAIN_SECURITY.md`,
`REGULATORY_THREAT_MODEL.md`, `LAUNCH_DAY_PLAYBOOK.md` and `INCIDENT_WARGAME.md`
— **do not exist in this repository.** They are planned, not drafted.

⭐ This is stated because a filename in a table reads as a document that exists,
and the first thing an auditor does with a security package is open the documents
it cites. A reference that 404s costs more credibility than an empty row would,
and the domains above carry **High** residual risk — that is the honest position
and it should not be discovered rather than disclosed.

Full findings and severities are in the Round 6 master report, held internally
and available to an external auditor on request.

---

## The "every angle" checklist (exhaustive test surface)

A living list of every attack/failure angle to test or document. ✅ = covered, 🟡 = drafted/partial,
⬜ = open. Nothing is removed; items only move to ✅.

### D1 — Contract code (✅ complete)
✅ Reentrancy · ✅ access control · ✅ integer over/underflow · ✅ oracle staleness/bounds ·
✅ no upgradeable contract (REG-53: SRXStaking, FeeController, StabilisationFund and SRXTreasury are plain contracts, so there is no upgrade path, upgrade key or storage layout to attack) · ✅ locked hub peer on every spoke (it accepts the hub or zero, nothing else) and the hub's per-chain inbound limit with guardian freeze ·
✅ launch-protection bypass on mint/burn · ✅ reward-pool solvency (`periodFinish`) ·
✅ Merkle replay/second-preimage · ✅ tier-boundary math · ✅ 16 Foundry invariants (7 token, 4 bridge, 5 reward pools) · ✅ Slither (CI).

### D2 — Deployment & TGE (✅ remediated)
✅ TGE destination allowlist gate (`verify_tge_targets.js`) · ✅ supply-sum invariant in the gate ·
✅ hardware-wallet mainnet signing · ✅ genesis interruption/recovery · ✅ stale-script deprecation ·
🟡 per-chain constructor-arg assertion (LZ/oracle) · ⬜ clean deploy-machine checklist executed.

### D3 — Economic (🟡)
🟡 month-by-month circulating-supply + unlock table · ⬜ sell-pressure vs LP-depth model ·
⬜ buyback-burn funding source confirmed · ⬜ staking emission vs inflation reconciliation ·
⬜ StabilisationFund real (stable/ETH) defense sizing · ⬜ launch price-discovery / LP-lock plan ·
⬜ sniper/MEV launch-day modeling.

### D4 — Bridge (🟡)
✅ hub-and-spoke: a spoke sends to and accepts from the hub only, at an address fixed at deployment · ✅ hub inbound limit per chain (a draining bucket; none set means no returns) with a guardian freeze that only governance lifts · ✅ each spoke's owner and LayerZero delegate behind that chain's own 48-hour Timelock · ⬜ the spoke pause and the Safe's roles on a spoke (internal audit M4, open) · ⬜ spoke burns counted on the hub (L9, open) ·
🟡 LayerZero DVN/executor config spec (≥2 independent DVNs) · ⬜ cross-chain supply reconciliation
monitor · ⬜ circuit-breaker thresholds set · ⬜ peer-set ceremony runbook · ⬜ reorg-on-mint handling ·
⬜ ZkSyncMigrator oracle = multisig + time-boxed.

### D5 — Governance (🟡)
✅ flash-loan-vote resistance (timestamp clock + snapshot + delay) · ⬜ delegation-participation target ·
⬜ quorum-at-low-delegation analysis · ⬜ committed decentralization milestone dates · ⬜ canceller-guardian
collusion model (internal audit M8, M9 open) · ✅ a paused staking contract or fund cannot hold principal indefinitely: irreversible exit-only wind-down (REG-53), started by the Timelock, the admin Safe (`WIND_DOWN_ROLE`) or anyone after a 30-day pause that no break of 7 days or more has interrupted (a shorter break does not restart the count, L2); exits return exactly the caller's own principal, no deadline once on, and no function moves anyone's tokens for them (a token-wide `SRXToken` pause still stops every transfer, exits included).

### D6 — Key management (🟡)
⬜ Safe signer set defined (count/roles/jurisdictional independence) · ⬜ key-generation ceremony ·
⬜ hardware/HSM requirement · ⬜ backup/recovery (Shamir/geographic) · ⬜ death/coercion/duress
contingency · ⬜ signer rotation · ⬜ 24/7 incident-reachability SLA.

### D7 — Oracle (🟡)
🟡 per-chain feed-address registry · ⬜ presale-deploy feed assertion · ⬜ L2 sequencer-uptime feed check ·
⬜ Chainlink-halt operational fallback · ⬜ heartbeat/deviation reconciled with staleness config.

### D8 — Supply-chain (🟡)
⬜ dependency CVE audit (OZ/LZ/transitive) · ⬜ deterministic/reproducible build process ·
⬜ bytecode-verification gate · ⬜ CI secret-scope review · ⬜ RPC-endpoint trust.

### D9 — Legal (🟡, counsel-owned)
🟡 mechanic→securities-law (Howey) threat map · ⬜ counsel opinion per jurisdiction · ⬜ presale KYC/AML
linkage · ⬜ sanctions screening · ⬜ exchange-listing legal readiness.

### D10 — Post-launch / social (🟡)
⬜ canonical verified-address publication · ⬜ fake-token monitoring · ⬜ approval-drainer warning
program · ⬜ signer social-engineering defense · ⬜ launch-protection parameter values decided.

### D11 — Formal verification (🟡)
✅ 7 single-contract Foundry invariants · ✅ 5 reward-pool invariants (REG-50, `RewardPoolsInvariant`) · ✅ cross-chain supply-conservation invariant (Foundry `BridgeConservationInvariant`, 8 Oct 2026; JS property test alongside) ·
⬜ full-TGE-sequence property · ✅ bridge conservation (`test/BridgeConservation.property.test.js`, `test/security-triage-2026-10.test.js`) · ⬜ external formal verification
(Certora/SMT) decision.

### D12 — Incident response (🟡)
⬜ tabletop wargame (key compromise / bridge exploit / oracle fail / governance attack) ·
⬜ Defender Sentinels actually created (spec'd, not live) · ⬜ pause-in-<15-min drill · ⬜ per-scenario
timed runbook.

---

## How to use this

1. The master report (`findings-2026-06-21-round6.md`) is the evidence + severities.
2. Each domain doc is the deep-dive + remediation.
3. This index is the checklist — drive every ⬜ to 🟡 to ✅.
4. When the checklist is all ✅, you have the strongest *internal* posture achievable — then
   engage the external auditor with this exact document set to make their pass fast and cheap.
