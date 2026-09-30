# SRX Token — Documentation

Public documentation for the SRX token smart-contract suite. This index is the
entry point for auditors, exchange listing teams, integrators, and the community.

> **Status:** Pre-mainnet. Contracts are feature-locked and have completed four
> internal audit rounds. An independent external audit is a mandatory gate before
> mainnet deployment.

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
| Mint policy | One-shot genesis only; no further minting ever |
| Burn policy | Deflationary via treasury buy-and-burn (`buyAndBurn`) |
| Standard | ERC-20 + ERC-2612 Permit + ERC20Votes + LayerZero V2 OFT |
| Origin chain | Ethereum (canonical OFT origin) |
| Bridged chains | BNB Chain, zkSync, + future (mint-on-receive / burn-on-send) |

### Allocation (genesis, 10B SRX)

The allocation table, the 5% launch-day float and the release calendar are generated from
`scripts/deploy/00_config.js` into [`TOKENOMICS.md`](TOKENOMICS.md); they are not repeated here.

Supply invariant (continuously verified by the Foundry invariant suite):
`totalSupply() == MAX_SUPPLY - totalBurned()`.

---

## Quick Facts for Integrators

- **No rebasing, no fee-on-transfer.** SRX is a standard ERC-20; balances do not change passively.
- **Launch protection** (optional, time-limited): max-transfer / max-wallet limits configurable
  at TGE and removed after the launch window. Exchanges/pools are exemptable.
- **Pausable:** transfers can be paused by the guardian in an emergency (documented trust model).
- **Governance:** on-chain via SRXGovernor + 48h SRXTimelock.
- **Upgradeability:** four peripheral contracts are UUPS; the token itself is non-upgradeable.
  Upgrade authority is a dedicated `UPGRADER_ROLE` held only by the Timelock post-deployment.

For addresses and ABIs, see the `srx-deployments` repository (published at mainnet TGE).
