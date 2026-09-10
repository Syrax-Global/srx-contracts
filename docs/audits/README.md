# SRX Token — Audit History

⚠️ **The per-round `findings-*.md` reports are held internally and are NOT in
this repository.** Links to them below will not resolve here; they are available
to an engaged auditor on request. The consolidated report
(`SRX_TOKEN_CONSOLIDATED_AUDIT_REPORT.pdf`) is the public artefact.


This directory publishes the audit history of the SRX token suite. Internal audit
reports were produced using a Halborn/Trail-of-Bits/OpenZeppelin-referenced
methodology (manual review, economic attack modeling, invariant verification,
threat-chain construction, deployment-gate enforcement).

> **All findings listed below have been remediated.** Reports are published for
> transparency; no unresolved Critical or High issues remain in the code.

---

## Summary

| Round | Date | Perspectives | Findings | Outcome |
|---|---|---|---|---|
| R1 | 2026-05-23 | Code correctness | — | Fixes applied |
| R2 | 2026-05-23 | Alternate perspective | — | Fixes applied |
| R3 | 2026-05-23 | Invariants, UUPS, bridge, ops, trust | 11 | 6 code fixes + Trust Matrix |
| R4 | 2026-05-29 | All 7 | 10 | All actionable items remediated |
| R5 | 2026-06-12 | All 7, fresh-eyes — remediation code as primary surface | 7 | 0 Critical/High/Medium; 4 Low code fixes + 3 info |

**Cumulative:** 42 findings across five rounds; all actionable items fixed.
**0 Critical / High / Medium outstanding.** The two Round-4 High findings were governance/
deployment topology (not code defects) and were both remediated. Round 5 — a different model
re-auditing the suite with the Round-4 remediations themselves treated as the primary attack
surface — surfaced only Low/Informational items (a contract-pair parity gap and presale
allocation-math refinements), all remediated with regression tests.

---

## The 7 Mandatory Audit Perspectives

Every SRX smart-contract audit covers all seven, either in one pass or across rounds:

1. **Code correctness** — off-by-one, missing guards, wrong operators, dead code.
2. **Economic / MEV / cross-contract** — sandwich, oracle arbitrage, tier-boundary gaming.
3. **Token invariants** — supply equation, reward-pool solvency, voting-power conservation.
4. **Upgradeability / storage** — slot collisions, initializer protection, gap discipline.
5. **LayerZero / bridge** — spoofed receive, peer authorization, replay, supply drift.
6. **Operational stress** — oracle failure, depeg, gas spikes, external-dependency failure modes.
7. **Centralization / trust map** — per-role compromise impact; full trust matrix.

---

## Round 4 Highlights (2026-05-29)

The most recent internal audit read all 13 production contracts in full. Headline
outcome: **the dominant risk was deployment-time role topology, not contract logic.**

| ID | Severity | Resolution |
|---|---|---|
| SC-TRUST-001 | High | Dedicated `UPGRADER_ROLE` separated from `GOVERNANCE_ROLE`; `_authorizeUpgrade` re-gated across all 4 UUPS contracts. |
| SC-TRUST-002 | High | `verify_roles.js` deployment gate — fails unless the deployer EOA holds zero roles and `UPGRADER_ROLE` is Timelock-only. |
| SC-TRUST-003 | Medium | StabilisationFund fast-path deployment restricted to a governance-approved target allowlist. |
| SC-LZ-001 | Medium | Bridge `setPeer` ownership migration to Timelock documented as a deployment gate. |
| SC-TRUST-004 | Medium | PreSaleRound admin = Gnosis Safe documented as a deployment gate. |
| SC-ECON-001 | Low | Synthetix `periodFinish` cap added to both reward systems — emission cannot exceed the funded pool. |
| SC-ECON-002 / SC-OPS-001 | Low | Per-feed oracle staleness + stablecoin price sanity bounds. |
| SC-CR-001 / SC-CR-004 | Low/Info | Airdrop NatSpec correction; reentrancy guards on presale invest paths. |

---

## Verification Coverage

- **649 Hardhat unit/integration tests** + 1 pending.
- **7 Foundry suites** — 4 invariants (supply, balance sum, voting power, burn cap) +
  3 property-fuzz tests; **51,200+ randomized calls, 0 reverts**.
- **Slither** static analysis enforced in CI (`fail-on: high`).
- **Foundry** invariant campaign (nightly, in CI). Echidna is a local harness
  only — the CI job was removed rather than left green over a suite whose
  properties could not fail.

---

## External Audit

An independent external audit (Halborn or Trail of Bits) is a **mandatory blocking
gate before any mainnet deployment**. The external report will be published in this
directory alongside the internal history when complete.

---

## Report Files

Full internal report markdown is maintained in the team's security workspace and
mirrored here upon public release of the repository:

- `findings-2026-05-23.md` (R1)
- `findings-2026-05-23-round2.md` (R2)
- `findings-2026-05-23-round3.md` (R3, includes Trust Matrix)
- `findings-2026-05-29.md` (R4, all 7 perspectives + remediation log)
