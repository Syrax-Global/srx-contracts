#!/usr/bin/env bash
#
# Build the public mirror of this repository.
#
# ⭐ WHY A MIRROR RATHER THAN MAKING THIS REPO PUBLIC.
#    This repository tracked a "Confidential Token Incentive Side Letter" and a
#    "Token Allocation Confirmation (Private Schedule)" from its first commit
#    until 10 Sep 2026. Removing them does not remove them: a blob stays
#    fetchable by SHA on the host until it garbage-collects, which a user cannot
#    trigger. Publishing this repo therefore requires rewriting published
#    history, force-pushing, and then TRUSTING that the host complied.
#
#    A mirror built from an allow-list never contained the material at all. That
#    is a materially stronger position than "we removed it and believe it is
#    gone", and it does not break a single existing clone.
#
# ⛔ ALLOW-LIST, NEVER A DENY-LIST. Every path published is named below. A
#    deny-list publishes anything nobody thought to exclude — which is precisely
#    how the side letter would have been published in the first place. The same
#    reasoning the credential guard applies to redaction applies here.
#
# Usage:
#   scripts/ci/build-public-mirror.sh [output-dir]
#
# The output is a plain directory with a fresh git history and ONE commit. It is
# not pushed anywhere by this script — publishing is a separate, deliberate act.

set -euo pipefail

OUT="${1:-../srx-token-public}"
SRC="$(git rev-parse --show-toplevel)"

# ── What gets published ──────────────────────────────────────────────────────
# Anything not named here does not leave this repository.
PUBLISH=(
  # The subject of the audit
  "contracts"
  "test"
  "scripts/deploy"
  "scripts/verify"
  "scripts/ops"
  "scripts/ci"

  # Build + toolchain, so a reviewer can reproduce the suite
  "hardhat.config.js"
  "foundry.toml"
  "remappings.txt"
  "package.json"
  "package-lock.json"
  ".solhint.json"
  ".solhintignore"
  "slither.config.json"
  ".npmrc"
  ".gitignore"
  # Named one by one, not the whole folder — see attribution-check.yml below.
  ".github/workflows/ci.yml"
  ".github/workflows/nightly-fuzz.yml"

  # Security package
  "SECURITY.md"
  "THREAT_MODEL.md"
  "AUDIT_SCOPE.md"
  "MULTISIG_SPEC.md"
  "INCIDENT_RESPONSE.md"
  "DEPLOYMENT_SECURITY.md"
  "TGE_DEPLOYMENT_RUNBOOK.md"
  "MONITORING.md"
  "RELEASING.md"
  "REPO_POLICY.md"
  "REMEDIATION.md"
  "docs"

  # Product documentation
  "README.md"
  "SRX_TOKEN_COMPLETE_OVERVIEW.md"
  "SRX_STAKING_OVERVIEW.md"
  "deploy/addresses.example.json"
)

# ── Deliberately NOT published, with reasons ─────────────────────────────────
#
#   Tokenomics & Investor Material/  confidential investor contract terms
#   INSTITUTIONAL_HARDENING_PLAN.md  internal planning, contains "Decision
#                                    required from you" and internal cost calls
#   CEX_LISTING_PACK.md              commercial material for exchange
#                                    counterparties, not a public artefact
#   TESTNET_TESTING_LOG.md           1,500-line internal working log
#   SRX_TOKEN_SECURITY_AUDIT_REPORT.docx  editable copy of our own audit report;
#                                    publishing an editable audit invites
#                                    tampering claims. The signed PDF in docs/
#                                    is the artefact.
#   AUDIT_PUBLICATION_PLAN.md        internal process document
#   SRX_TOKEN_INNOVATION_ROADMAP.md  forward-looking commercial material
#   .openzeppelin/                   deployment manifests — publish deliberately
#                                    if wanted, but they are operational state
#   .github/workflows/attribution-check.yml
#                                    the internal commit-message check. It names
#                                    the tools it blocks, so publishing it would
#                                    itself be the statement it exists to prevent;
#                                    the tool-attribution scan below rightly
#                                    refuses it. The public repo's commits are
#                                    made by this script, and every published
#                                    file is scanned before it is committed.

echo "Building public mirror -> $OUT"

# ⭐ PRESERVE .git IF THE MIRROR ALREADY EXISTS. The first version rm -rf'd the
#    output and re-ran `git init`, which produces a brand-new root commit every
#    time — so every update would have been a FORCE-PUSH over the published
#    repository, destroying its history and breaking every clone. A mirror is a
#    thing you update, not a thing you re-create.
EXISTING_GIT=""
if [ -d "$OUT/.git" ]; then
  EXISTING_GIT="$(mktemp -d)/git"
  mv "$OUT/.git" "$EXISTING_GIT"
  echo "  (updating an existing mirror — history preserved)"
fi

rm -rf "$OUT"
mkdir -p "$OUT"
[ -n "$EXISTING_GIT" ] && mv "$EXISTING_GIT" "$OUT/.git"

for path in "${PUBLISH[@]}"; do
  if [ -e "$SRC/$path" ]; then
    mkdir -p "$OUT/$(dirname "$path")"
    cp -R "$SRC/$path" "$OUT/$path"
    echo "  + $path"
  else
    echo "  . $path (absent, skipped)"
  fi
done

# ── The ownership notice ─────────────────────────────────────────────────────
# ⛔ Syrax does not open-source its products (Jared, 23 Sep 2026). The source
#    repository carries the private NOTICE, which calls the contents confidential —
#    untrue of a published repository. The mirror carries NOTICE-public instead:
#    readable, compilable to verify a deployment, all rights reserved.
cp "$SRC/NOTICE-public" "$OUT/NOTICE"
echo "  + NOTICE (from NOTICE-public)"

# ── Verify, rather than assume ───────────────────────────────────────────────
echo
echo "── Verification ─────────────────────────────────────────────"

fail=0

# 1. no confidential material
#
# ⚠️ NAME-BASED, deliberately blunt, and it produces false positives — that is the
#    correct trade. A tripwire that occasionally catches something harmless is
#    worth far more than one narrow enough to miss the side letter. False
#    positives are allow-listed BY PATH, with a reason, never by loosening the
#    pattern.
CONFIDENTIAL_OK=(
  # A Sepolia helper that funds a test wallet. Matches "*investor*" by name only;
  # it holds no secret, it reads INVESTOR_PRIVATE_KEY from the environment.
  "scripts/ops/fund_investor.js"
)
hits=$(find "$OUT" \( -iname "*confidential*" -o -iname "*private schedule*" -o -iname "*investor*" \) | sed "s|^$OUT/||")
for ok in "${CONFIDENTIAL_OK[@]}"; do
  hits=$(printf '%s\n' "$hits" | grep -vxF "$ok" || true)
done
if [ -n "$(printf '%s' "$hits" | tr -d '[:space:]')" ]; then
  echo "  ✗ confidential-looking file present:"
  printf '      %s\n' $hits
  fail=1
else
  echo "  ✓ no confidential/investor-named files (${#CONFIDENTIAL_OK[@]} allow-listed by path)"
fi

# 2. no tool attribution
#
# ⚠️ CASE-INSENSITIVE. Three separate sweeps missed references on 9-10 Sep because
#    they were case-sensitive or searched a list of names somebody thought of:
#    ".claude/" is lowercase, and "Fable" was not in the first pattern.
# ⚠️ And this script is EXCLUDED from its own content scan, because it necessarily
#    contains every term it hunts for. Without that it fails on itself, which is a
#    check that cries wolf and gets ignored.
ATTRIB_PAT="\.claude|anthropic|chatgpt|\bopus\b|\bfable\b|\bsonnet\b|\bhaiku\b|openai|gemini|\bclaude\b"
attrib=$(grep -rIl --exclude-dir=node_modules -iE "$ATTRIB_PAT" "$OUT" 2>/dev/null \
         | grep -v "scripts/ci/build-public-mirror.sh" || true)
if [ -n "$attrib" ]; then
  echo "  ✗ tool attribution present:"
  printf '      %s\n' $attrib
  fail=1
else
  echo "  ✓ no tool attribution (case-insensitive)"
fi

# 3. no env/key material
if find "$OUT" \( -name ".env" -o -name "*.pem" -o -iname "*keystore*" -o -iname "*mnemonic*" \) | grep -q .; then
  echo "  ✗ credential-shaped file present"
  fail=1
else
  echo "  ✓ no env/keystore/mnemonic files"
fi

# 4. no open-source licence
#
# ⚠️ A LICENSE file is a grant. This mirror published one under MIT until 23 Sep 2026;
#    versions already taken keep that licence, which is exactly why it must not recur.
if find "$OUT" -maxdepth 1 \( -iname "LICEN[CS]E*" -o -iname "COPYING*" \) | grep -q .; then
  echo "  ✗ an open-source licence file is present"
  fail=1
elif grep -qE '"license" *: *"(MIT|ISC|Apache|BSD)' "$OUT/package.json" 2>/dev/null; then
  echo "  ✗ package.json declares an open-source licence"
  fail=1
else
  echo "  ✓ no open-source licence file or manifest declaration"
fi

[ "$fail" -eq 0 ] || { echo; echo "⛔ VERIFICATION FAILED — do not publish this tree."; exit 1; }

# ── Commit ───────────────────────────────────────────────────────────────────
cd "$OUT"

SRC_SHA="$(git -C "$SRC" rev-parse --short HEAD)"

if [ ! -d .git ]; then
  git init -q
  MSG="SRX token — public release

Smart contracts, test suite and security documentation for the SRX token.

Built from an allow-list of published paths. No inherited history: internal
working documents, commercial material and investor documentation were never
part of this repository."
else
  MSG="sync: mirror of srx-token@${SRC_SHA}

Rebuilt from the allow-list in scripts/ci/build-public-mirror.sh."
fi

git add -A

# 4. every document reference resolves IN THE PUBLISHED TREE
#
# ⛔ The public repo's CI failed this check on every sync from 10 Sep to 17 Sep:
#    its README pointed at .openzeppelin/ and docs/README.md at an internal plan,
#    both deliberately left out of the mirror. The private repo passed, because
#    the files exist THERE. Only the published tree can answer this, so it is
#    checked here, after staging, and a failing tree is never committed.
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import sys" >/dev/null 2>&1; then
  git reset -q
  echo "⛔ python3 is not available, so the document-reference check cannot run — refusing to commit."
  exit 1
fi
if ! python3 scripts/ci/check-doc-refs.py; then
  git reset -q
  echo
  echo "⛔ VERIFICATION FAILED — a published document references a file the mirror does not contain."
  exit 1
fi
echo "  ✓ every document reference resolves in the published tree"

if git diff --cached --quiet; then
  echo
  echo "✓ Mirror already matches srx-token@${SRC_SHA} — nothing to commit."
  exit 0
fi

git -c user.name="Syrax" -c user.email="security@syrax.global" commit -q -m "$MSG"

echo
echo "✓ Mirror at $OUT is now srx-token@${SRC_SHA} ($(git rev-list --count HEAD) commit(s))."
echo
echo "⛔ NOT PUSHED. Publishing is a separate, deliberate act:"
echo "     cd $OUT && git push origin main"
