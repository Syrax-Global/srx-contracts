# SRX Token — Repository Policy

## Visibility

| Phase | Visibility | Trigger |
|---|---|---|
| Pre-audit (now) | **Private** | Default until Halborn audit complete |
| Post-audit | **Public** | After audit report published + all findings resolved |
| Mainnet | **Public** | Permanently public from TGE onwards |

The repository is private during development and the external audit period.
Making it public before the audit is complete exposes attack surface before
defences are independently verified.

## Repository Structure

```
Syrax-Global/srx-token       ← This repo (contracts + tests)
Syrax-Global/srx-deployments ← Deployment records, addresses, ABIs (create at TGE)
```

`srx-token` contains only source code, tests, and configuration.
Deployed contract addresses, constructor args, and verification artefacts live
in a separate `srx-deployments` repo so contract source remains clean.

## Branch Model

| Branch | Purpose | Direct push |
|---|---|---|
| `main` | Canonical audited code | ❌ Never |
| `feature/*` | New features | ✅ Author only |
| `fix/*` | Bug fixes | ✅ Author only |
| `audit/*` | Audit response branches | ✅ Author only |
| `release/*` | Release preparation | ✅ Author only |

All merges to `main` require:
1. A pull request (no direct pushes, no force pushes)
2. At least one approving review
3. All CI checks passing (see `all-checks` gate job in `.github/workflows/ci.yml`)

## Secrets Management

No secrets, private keys, or wallet mnemonics are ever committed.
`.env` files are gitignored globally.
The `secrets` CI job (gitleaks) scans every push for accidental leaks.

If a secret is accidentally committed:
1. Rotate the secret immediately — assume it is compromised.
2. Remove it from git history using `git filter-repo`.
3. Force-push only after rotating — never before.

## External Audit

Before making the repo public:
- [ ] Halborn audit complete, report received
- [ ] All Critical and High findings resolved
- [ ] Resolution commits reviewed and signed off by auditor
- [ ] TGE_DEPLOYMENT_RUNBOOK.md reviewed and approved

## Mainnet Checklist

Before any mainnet deployment:
- [ ] Repo is public
- [ ] Latest audit report linked in README
- [ ] DEFAULT_ADMIN_ROLE transferred to Gnosis Safe (≥3/5)
- [ ] All deployment scripts reviewed against the TGE runbook
- [ ] Deployment addresses published in `srx-deployments`
