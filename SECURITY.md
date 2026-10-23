# SRX Token — Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the SRX Token smart contracts,
please report it responsibly. **Do not open a public GitHub issue.**

### Contact

- **Email:** security@syrax.global
- **Encrypted reports:** a PGP key and its fingerprint will be published here before
  mainnet. Until then, email the address above and ask; we will arrange an encrypted
  channel before you send any details.

### What to Include

1. Description of the vulnerability
2. Affected contract(s) and function(s) — file path + line number
3. Reproduction steps or proof-of-concept code
4. Impact assessment (funds at risk, accounts affected)
5. Suggested mitigation (if any)
6. Your contact details (or anonymous if preferred)

### What We Promise

| | |
|---|---|
| Acknowledgement | Within 24 hours of receipt, with a reference number |
| Initial triage (scope, plausibility, initial severity) | Within 72 hours of receipt |
| Status updates | At least every 7 days until the report is resolved |
| Public disclosure | Coordinated with reporter after fix is deployed |
| Hall of fame | Public acknowledgement (with reporter's consent) |
| Bug bounty | See below |

---

## Bug Bounty Programme

> **Status:** Programme launches at TGE, run by Syrax. Funds are pre-allocated from
> the ecosystem treasury.

### Scope

In scope:
- Every production contract in `contracts/` (excluding `contracts/mocks/` and `contracts/echidna/`)
- Deployed mainnet contracts (Ethereum + BNB Chain at launch)
- Cross-chain bridge logic (LayerZero V2 OFT integration)
- Frontend wallet-interaction code (when public)

Out of scope:
- Test code (`test/`, `test/foundry/`, `contracts/echidna/`)
- Mock contracts (`contracts/mocks/`)
- LayerZero protocol itself (report to LayerZero directly)
- OpenZeppelin libraries (report to OpenZeppelin directly)
- Front-end issues not affecting fund safety (UI bugs → public issues)
- Social engineering, phishing, or rug-pull-by-design accusations
- Vulnerabilities requiring physical access to admin keys

### Severity & Rewards

| Severity | Definition | Reward (USD equivalent in SRX) |
|---|---|---|
| **Critical** | Direct loss of user funds, unauthorized minting, bridge takeover, admin key bypass | $50,000 – $250,000 |
| **High** | Theft of contract funds (non-user), permanent freeze of significant funds, bypass of multi-sig | $10,000 – $50,000 |
| **Medium** | Theft of small / capped funds, temporary freeze, governance manipulation | $2,500 – $10,000 |
| **Low** | Griefing, gas-only attacks, minor incorrect-accounting issues with no fund loss | $500 – $2,500 |
| **Informational** | Best-practice deviations, non-exploitable findings | Acknowledgement |

Reward is at the discretion of the Syrax security team based on:
- Quality of report
- Reproducibility
- Exploitability in production conditions
- Whether the issue is novel or a duplicate

### Rules

1. **Responsible disclosure only.** Do not publish details until a fix is
   deployed and we have coordinated public disclosure.
2. **No exploitation.** Do not test against mainnet. Use Sepolia testnet or
   local forks for proof-of-concept.
3. **No user harm.** Do not interact with other users' funds, even
   theoretically.
4. **No spam.** Auto-generated reports from scanners without analysis are not
   eligible.
5. **One reward per unique vulnerability.** First report wins.
6. **Conflicts of interest.** Team members, advisors, contractors, and their
   immediate family are not eligible.

### Payment

Rewards are paid in SRX or USD-equivalent stablecoin (reporter's choice)
within 30 days of vulnerability remediation. Sanctions screening applies —
reporters in OFAC-restricted jurisdictions cannot receive payment.

---

## Audit History

| Round | Date | Type | Methodology | Report |
|---|---|---|---|---|
| Internal R1 | 2026-05-23 | Internal | Code correctness | `docs/audits/` |
| Internal R2 | 2026-05-23 | Internal | Alternate-perspective re-audit | `docs/audits/` |
| Internal R3 | 2026-05-23 | Internal | Perspectives 3–7 + Trust Matrix | `docs/audits/` |
| Internal R4 | 2026-05-29 | Internal | All 7 mandatory perspectives | `docs/audits/` |
| Internal R5 | 2026-06-12 | Internal | All 7, fresh-eyes — remediation code as primary surface | `docs/audits/` |
| Proof pass 1 | 2026-09-10 | Internal | Executable proofs only | `REMEDIATION.md` |
| Proof pass 2 | 2026-09-23 | Internal | Full pre-external-audit sweep, contracts and deploy path | `REMEDIATION.md` |
| Internal audit | 2026-10-16 | Internal | Every contract, six review groups: twin and sibling sweep, privileged functions, accounting, entry points, funds with no exit, every documented guarantee against a test | `REMEDIATION.md` |
| Class sweep + second static analyser | 2026-10-22 | Internal | Every contract, per class of mistake reported publicly; Aderyn alongside Slither; accounting invariants | `REMEDIATION.md`, `docs/audits/STATIC_ANALYSIS_TRIAGE.md` |
| Review round | 2026-10-22 | Internal | Five independent reviews of the contracts and deploy scripts, each finding proven by a test before the fix. Two Mediums (A1, A4: the bridge's per-chain inbound bucket counts gross returns) are open for a design decision | `REMEDIATION.md` |
| Mutation and boundary testing | 2026-10-23 | Internal | Every access modifier and guard removed, and every guard comparison flipped, one at a time against the whole suite: every non-equivalent mutant is now killed (656 mutants; tests added for 45). In-scope coverage 99.08% of statements, 98.41% of branches | `AUDIT_SCOPE.md` §5 |
| External | TBD (pre-mainnet) | External firm | Not yet commissioned | Pending |

Across rounds R1–R5, 42 findings were identified and all actionable items remediated. Those
rounds did not catch everything: two later proof passes, which count a finding only once a
test demonstrates it, found 31 defects on 10 September and, on 23 September, a Critical, three
Highs and a further deployment High. Fixes and the items still open are in `REMEDIATION.md`.
Verification coverage:
- **1,624 Hardhat tests** (0 failing, 23 Oct 2026; 99.08% of statements and 98.41% of branches of the in-scope contracts) + **33 Foundry invariants** (256 runs × depth 50) and **5 property-fuzz tests** (1,000 runs each; 10,000 in the nightly profile).
- Aderyn 0.6.8 alongside Slither; every finding of both is fixed or explained in `docs/audits/STATIC_ANALYSIS_TRIAGE.md`.
- Slither static analysis in CI: version pinned (0.11.6), failing on Medium and High. No detector that can report a High is excluded repo-wide; each reviewed exception is a dated comment beside the code. Foundry is pinned too (forge v1.8.5, forge-std v1.16.1).
- Foundry invariant campaign (nightly, in CI). Echidna is a local harness only.

The audit history is in [`docs/audits/`](docs/audits/); the full per-round reports are held internally and
are available to an external auditor on request. The items the 16 October internal audit left open
for a decision are listed in `REMEDIATION.md`. An independent external audit is next, and is a
**mandatory gate before mainnet**.

---

## Supported Versions

Only the latest deployed mainnet version is eligible for bounty rewards.
Testnet-only issues are out of scope unless they also exist in mainnet code.

| Version | Supported |
|---|---|
| `v1.0.x` (mainnet) | ✅ |
| `v0.x.x` (pre-mainnet) | ❌ |

---

## Hall of Fame

We publicly acknowledge security researchers who responsibly disclose
vulnerabilities (with their consent). Reports on pre-mainnet code are credited here
too; only the latest deployed mainnet version is eligible for a reward.

| Researcher | Date | Severity | Description |
|---|---|---|---|
| [ibnu76](https://github.com/ibnu76) | 20 Sep 2026 | High, Low | StabilisationFund: rewards scheduled against accrued-but-unclaimed rewards (SSF-H2), and no minimum contribution, so a 1-wei position could block the stranded-pool rescue (SSF-L1). Both fixed; see `REMEDIATION.md`. |

---

## Public Disclosure Policy

Once a vulnerability is fixed and the fix is deployed:

1. We will publish a security advisory in this repository's Security tab.
2. The advisory will include: severity, affected versions, fix commit,
   credit to reporter (with consent).
3. Post-mortem will be published on the Syrax blog within 14 days.
4. For Critical issues affecting deployed funds, an on-chain
   announcement is made via the Twitter/X account.

We commit to coordinated disclosure on a reasonable timeline — typically
30 days from initial report, extended if active exploitation risk requires.
