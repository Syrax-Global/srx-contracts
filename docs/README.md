# SRX Token — Documentation

Public documentation for the SRX token smart-contract suite. This index is the
entry point for auditors, exchange listing teams, integrators, and the community.

> **Status:** Pre-mainnet. Contracts are feature-locked and have been through five
> internal audit rounds, two proof passes and an internal audit on 16 October 2026
> (a few of its items are still open for design decisions: see `AUDIT_SCOPE.md`).
> An independent external audit is a mandatory gate before mainnet deployment. It is
> upcoming and has not been engaged.

---

## Contents

### Protocol
- [Contract Reference](CONTRACTS.md) — every deployed contract, its role, and its trust assumptions
- [Tokenomics](#tokenomics) — supply, allocations, vesting (summary below)

### Security
- [Security Policy & Bug Bounty](../SECURITY.md) — how to report vulnerabilities, reward tiers
- [Audit History & Reports](audits/README.md) — all internal audit rounds + external (pending)
- [Multisig & Role Topology](../MULTISIG_SPEC.md) — Gnosis Safe spec, role-migration runbook
- [On-Chain Monitoring](../MONITORING.md) — alerting and Sentinel configuration
- [Incident Response Playbook](../INCIDENT_RESPONSE.md) — SEV-1…4 procedures

### Engineering & Governance
- [Repository Policy](../REPO_POLICY.md) — visibility, branch model, secrets
- [Release & Versioning](../RELEASING.md) — semver convention, release procedure

### Exchange / Listing
- [CEX Listing Questionnaire](LISTING_QUESTIONNAIRE.md) — pre-filled due-diligence answers

---

## Tokenomics

| Parameter | Value |
|---|---|
| Name / Symbol | Syrax Token / SRX |
| Max supply | 10,000,000,000 SRX (fixed, 18 decimals) |
| Mint policy | One-shot genesis only; no function creates new supply afterwards (a bridge return re-credits only SRX burned on send, up to what was sent to that chain) |
| Burn policy | Deflationary via treasury buy-and-burn (`buyAndBurn`) |
| Standard | ERC-20 + ERC-2612 Permit + ERC20Votes + LayerZero V2 OFT |
| Origin chain | Ethereum (canonical OFT origin) |
| Bridged chains | BNB Chain, zkSync, + future (mint-on-receive / burn-on-send, hub-and-spoke through Ethereum) |

### Allocation (genesis, 10B SRX)

The allocation table, the 5% launch-day float and the release calendar are generated from
`scripts/deploy/00_config.js` into [`TOKENOMICS.md`](TOKENOMICS.md); they are not repeated here.

Supply invariant: with nothing bridged out, `totalSupply() == MAX_SUPPLY - totalBurned()` (checked by the
Foundry invariant suite, which does not model bridge sends). With bridging,
`totalSupply() + sum(outstandingByEid) == MAX_SUPPLY - totalBurned()` on Ethereum
(`test/BridgeConservation.property.test.js`).

---

## Quick Facts for Integrators

- **No rebasing, no fee-on-transfer.** SRX is a standard ERC-20; balances do not change passively.
- **Launch protection** (optional, time-limited): max-transfer / max-wallet limits configurable
  at TGE and removed after the launch window. Exchanges/pools are exemptable.
- **Pausable:** transfers can be paused by the guardian in an emergency (documented trust model): at most 14 days at a time and 30 in total, and anyone can lift it after that.
- **Governance:** on-chain via SRXGovernor + 48h SRXTimelock.
- **Upgradeability:** none. No SRX contract is upgradeable: the token and every other contract are
  non-upgradeable, and SRXStaking, FeeController, StabilisationFund and SRXTreasury are plain
  contracts deployed directly (REG-53). There is no upgrade role. Parameters stay adjustable through
  governance (48h Timelock); a fix ships as a new contract that holders choose to move to
  (see [`MIGRATION.md`](MIGRATION.md)).
- **Wind-down (exit-only) mode:** SRXStaking and StabilisationFund each have an irreversible
  exit-only mode. Once on, no new deposits are accepted and each holder can take back exactly
  their own principal, with no penalty and no lock wait, and with no deadline. It works while the
  contract is paused, but a token-wide `SRXToken` pause still stops every transfer.

For addresses and ABIs, see the `srx-deployments` repository (published at mainnet TGE).
