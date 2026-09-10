# SRX Token — Release & Versioning Convention

## Versioning Scheme

SRX Token follows [Semantic Versioning](https://semver.org/): `vMAJOR.MINOR.PATCH`

| Segment | Bump when |
|---|---|
| MAJOR | Breaking change to ABI, storage layout, or deployed contract behaviour |
| MINOR | New non-breaking feature (new function, new event, new role) |
| PATCH | Bug fix, gas optimisation, comment/NatSpec update, test-only change |

### Examples

| Change | Version bump |
|---|---|
| Add `rescueETH()` to BuybackBurner | `MINOR` → v1.1.0 |
| Fix staleness check bug in PreSaleRound | `PATCH` → v1.0.1 |
| Restructure storage layout (requires migration) | `MAJOR` → v2.0.0 |
| Update NatSpec comments only | `PATCH` → v1.0.1 |
| Add new oracle price bounds | `MINOR` → v1.1.0 |

## Pre-TGE Versions (Current)

All releases before mainnet TGE are prefixed `v0.x.y` to signal
that no backwards-compatibility guarantee exists yet:

- `v0.1.0` — initial testnet deployment (Sepolia + BSC testnet)
- `v0.2.0` — post-audit fixes applied
- `v1.0.0` — mainnet TGE (first stable release)

`v1.0.0` is reserved exclusively for the mainnet deployment.

## How to Cut a Release

### 1. Prepare the release branch

```bash
git checkout -b release/v1.0.0
```

Update `package.json` version field to match:
```json
{ "version": "1.0.0" }
```

### 2. Run the full test suite

```bash
npm run test:all
```

All tests must pass. No exceptions.

### 3. Run Slither one final time

```bash
npm run slither
```

No new HIGH or CRITICAL findings. Document any accepted LOW/INFO items.

### 4. Commit the release

```bash
git add package.json
git commit -m "chore: bump version to v1.0.0"
git push origin release/v1.0.0
```

Open a PR from `release/v1.0.0` → `main`. Requires review + CI green before merge.

### 5. Tag the release

After the PR merges to `main`:

```bash
git checkout main
git pull origin main
git tag -a v1.0.0 -m "SRX Token v1.0.0 — mainnet TGE"
git push origin v1.0.0
```

### 6. Publish a GitHub Release

```bash
gh release create v1.0.0 \
  --title "SRX Token v1.0.0 — Mainnet TGE" \
  --notes "See CHANGELOG.md for full details." \
  --repo Syrax-Global/srx-token
```

## Changelog

Every release tag must have a corresponding entry in `CHANGELOG.md` (to be
created at v1.0.0) covering:

- What changed
- What was fixed
- Any audit findings resolved
- Deployed contract addresses (linked to `srx-deployments`)

## Hotfix Releases

For critical post-deployment fixes:

```bash
git checkout -b fix/critical-reentrancy-fix main
# make fix
git commit -m "fix: guard against reentrancy in BuybackBurner"
# PR → main → merge → tag v1.0.1
```

Never patch a deployed contract without a full re-audit of the changed functions.
