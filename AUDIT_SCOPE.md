# SRX Token — External Audit Scope & Handoff Package

Prepared for external audit engagement (CertiK / Halborn / Trail of Bits / OpenZeppelin).
This document gives an auditor everything needed to (a) quote accurately and (b) start fast.

---

## 1. Project Overview

**Syrax Token (SRX)** — the utility & governance token of the Syrax ecosystem. A fixed-supply
(10,000,000,000) ERC-20 with EIP-2612 Permit, ERC20Votes governance, and LayerZero V2 OFT
cross-chain transfer. Origin chain: Ethereum; bridged to BNB Chain (and zkSync/future chains).
Includes vesting, presale, staking (fee tiers + Synthetix rewards), on-chain treasury, a
three-tier stabilisation fund, on-chain governance (Governor + 48h Timelock), a non-upgradeable
guardian/circuit-breaker module, and a burn-to-migrate path for a future app-chain.

## 2. Repository & Commit

- **Repo:** `github.com/Syrax-Global/srx-token` (private — grant read access to the audit team's
  GitHub org/handles, or provide an archive of the tagged commit).
- **Audit target commit:** tag a frozen commit before handoff — recommended `v0.9.0-audit`
  (`git tag -a v0.9.0-audit -m "external audit target" && git push origin v0.9.0-audit`). Audit the
  tag, not a moving branch.
- **No secrets in repo:** `.env` is gitignored; no keys/mnemonics committed.

## 3. Scope

**In scope — 15 production contracts, 5,917 LOC (`contracts/`, excluding `mocks/` & `test/`):**

| Contract | LOC | Notes |
|---|---|---|
| `presale/PreSaleRound.sol` | 1,065 | ETH/USDC/USDT/WBTC presale, Chainlink pricing, tier bonuses, per-investor vaults |
| `stabilisation/StabilisationFund.sol` | 921 | UUPS. 3-tier emergency deployment, Synthetix contributor rewards |
| `staking/SRXStaking.sol` | 850 | UUPS. Fee-tier locks + dual Synthetix reward pools (SRX + bonus) |
| `guardian/GuardianModule.sol` | 596 | Non-upgradeable. Per-module pause, circuit breaker, immutable sunset |
| `staking/FeeController.sol` | 398 | UUPS. Pure fee calculator (read via eth_call) |
| `token/SRXToken.sol` | 344 | OFT + Permit + Votes + launch protection |
| `vesting/VestingVault.sol` | 268 | Single-beneficiary linear vesting + revoke |
| `buyback/BuybackBurner.sol` | 270 | Swap-and-burn / direct-burn |
| `treasury/SRXTreasury.sol` | 258 | UUPS. Timelock-controlled spend + buy-and-burn |
| `migration/ZkSyncMigrator.sol` | 225 | Burn-to-migrate for future app-chain |
| `airdrop/SRXAirdrop.sol` | 199 | Chain-bound double-hash Merkle airdrop |
| `governance/SRXGovernor.sol` | 168 | OZ Governor (timestamp clock, 4% quorum, 1M threshold) |
| `token/TGEDistributor.sol` | 168 | One-shot genesis distributor |
| `bridge/SRXOFTNative.sol` | 137 | Remote-chain OFT representation |
| `governance/SRXTimelock.sol` | 50 | OZ TimelockController (48h) |

**Out of scope:** `contracts/mocks/`, `contracts/test/`, `test/`, `scripts/` (deployment/ops
scripts — see note in §7), OpenZeppelin & LayerZero library code.

**Complexity flags for quoting:** 4 UUPS-upgradeable contracts; LayerZero V2 OFT cross-chain;
Chainlink oracle integration; two Synthetix-pattern reward systems; on-chain governance + timelock.

## 4. Tech Stack & Build

- Solidity **0.8.24**, `viaIR: true`, optimizer 200 runs, EVM `cancun`.
- **Hardhat** (unit/integration) + **Foundry** (invariant/property fuzzing).
- OpenZeppelin Contracts **v5.1** + Contracts-Upgradeable v5.1; LayerZero **oft-evm v4 / V2 endpoints**.
- Build: `npm ci` (repo has `.npmrc legacy-peer-deps=true` for a LayerZero transitive peer conflict),
  then `npx hardhat compile`. Foundry: `git clone https://github.com/foundry-rs/forge-std lib/forge-std`
  then `forge build` (note: `forge` runs under WSL on the maintainer's Windows box; standard on Linux/Mac).

## 5. Test Coverage (hand this over — it de-risks their review)

- **666 Hardhat tests** (unit + integration), 1 pending — `npx hardhat test`.
- **7 Foundry suites** — 4 invariants + 3 property-fuzz, **51,200+ randomized calls, 0 reverts** —
  `forge test -vv`. Invariants: supply equation, balance-sum, voting-power ≤ supply, burned ≤ max.
- Slither (CI, `fail-on: high`) + a nightly Foundry invariant campaign.
  ⚠️ Echidna is a LOCAL harness (`contracts/echidna/`), not a CI control: the
  original suite could not fail — every property returned true unconditionally
  because genesis was unreachable from the harness — and the CI job was removed
  rather than left green over a vacuous check. It was rewritten so the harness
  is admin; reinstating it in CI needs a pinned image and a real failure mode.

## 6. Prior Audit History (6 internal rounds — provide these to accelerate their pass)

Documented at `docs/audits/README.md` (public-safe summary), with the
consolidated report at `docs/audits/SRX_TOKEN_CONSOLIDATED_AUDIT_REPORT.pdf`.
Per-round reports are held internally and available to an engaged auditor on
request; they are not in this repository.

| Round | Focus | Outcome |
|---|---|---|
| R1–R3 | Code correctness, invariants, UUPS, bridge, ops, trust matrix | 24 findings, remediated |
| R4 | All 7 perspectives | 2 High (governance topology) → fixed (UPGRADER_ROLE split + `verify_roles.js`) |
| R5 | Fresh-eyes, remediation code as primary surface | 0 new C/H/M; 4 Low fixed w/ regression tests |
| R6 | Holistic systemic (deployment, economic, bridge, keys, oracle, legal…) | Off-chain surface; TGE destination gate remediated |

**All contract-code Critical/High/Medium resolved.** 42+ findings across rounds; all actionable
items fixed and regression-tested.

## 7. Disclosed Trust Assumptions & Focus Requests (please scrutinise)

We proactively disclose our centralization/trust model (`MULTISIG_SPEC.md` + R4 trust matrix) so
the review can focus. We'd especially value external scrutiny on:
1. **LayerZero OFT bridge** — mint/burn conservation, `setPeer` authority, DVN/executor trust (our
   `BRIDGE_SECURITY_MODEL.md` is in progress; independent view welcome).
2. **UUPS upgrade authority** — we split a Timelock-only `UPGRADER_ROLE` from `GOVERNANCE_ROLE`
   (SC-TRUST-001); confirm the topology + `verify_roles.js` gate.
3. **PreSaleRound oracle math** — Chainlink pricing, staleness/bounds, tier-bonus inversion.
4. **Synthetix reward accounting** — `periodFinish` emission caps in Staking + StabilisationFund.
5. **Deployment/TGE execution** — the deploy scripts move 10B SRX; our R6 `DEPLOYMENT_SECURITY.md`
   + `verify_tge_targets.js` gate address this, but a review of the deploy path is welcome
   (typically out of a standard contract-only scope — flag if you'd include it).

## 8. What We Can Provide

- Read access to the private repo at the tagged audit commit (or a source archive).
- Full internal audit reports (6 rounds), the trust matrix, and this scope package.
- The maintainer team is responsive for questions and re-review of fixes.

## 9. Contact

- Technical: **[FILL — name, email]**
- Security: **security@syrax.global**
