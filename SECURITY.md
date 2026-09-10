# SRX Token — Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the SRX Token smart contracts,
please report it responsibly. **Do not open a public GitHub issue.**

### Contact

- **Email:** security@syrax.global
- **PGP key:** [FILL — publish PGP key + fingerprint at TGE]
- **Encrypted alternative:** [Signal or Keybase handle — FILL]
- **Response time:** Within 24 hours, 7 days a week.

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
| Acknowledgement | Within 24 hours |
| Initial triage | Within 72 hours |
| Status updates | Every 7 days until resolution |
| Public disclosure | Coordinated with reporter after fix is deployed |
| Hall of fame | Public acknowledgement (with reporter's consent) |
| Bug bounty | See below |

---

## Bug Bounty Programme

> **Status:** Programme launches at TGE. Self-hosted until Immunefi sponsorship
> is in place. Funds are pre-allocated from the ecosystem treasury.

### Scope

In scope:
- All 13 production contracts in `contracts/` (excluding `contracts/mocks/`)
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
| Internal R1 | 2026-05-23 | Internal | Halborn-reference (code correctness) | `docs/audits/` |
| Internal R2 | 2026-05-23 | Internal | Alternate-perspective re-audit | `docs/audits/` |
| Internal R3 | 2026-05-23 | Internal | Perspectives 3–7 + Trust Matrix | `docs/audits/` |
| Internal R4 | 2026-05-29 | Internal | All 7 mandatory perspectives | `docs/audits/` |
| Internal R5 | 2026-06-12 | Internal | All 7, fresh-eyes — remediation code as primary surface | `docs/audits/` |
| External | TBD (pre-mainnet) | External firm | Halborn / Trail of Bits | Pending |

Across five internal rounds, 42 findings were identified and all actionable items
remediated (0 Critical / High / Medium outstanding; the 2 Round-4 High findings were
governance/deployment-topology issues, both fixed via `UPGRADER_ROLE` separation and the
`verify_roles.js` deployment gate). The Round-5 fresh-eyes pass — a different model
re-auditing with the Round-4 remediations themselves as primary attack surface — found only
Low/Informational items, all remediated. Verification coverage:
- **663 Hardhat tests** + **7 Foundry invariant/property suites** (51,200+ randomized calls, 0 reverts).
- Slither static analysis in CI (`fail-on: high`).
- Foundry invariant campaign (nightly, in CI). Echidna is a local harness only.

Full reports are mirrored under [`docs/audits/`](docs/audits/) when the repository
is made public. An independent external audit is a **mandatory gate before mainnet**.

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

We will publicly acknowledge security researchers who responsibly disclose
vulnerabilities (with their consent). This section will be populated post-TGE.

| Researcher | Date | Severity | Description |
|---|---|---|---|
| — | — | — | — |

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
