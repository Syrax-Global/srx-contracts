#!/usr/bin/env python3
"""Fail if a document references a file that does not exist.

⭐ WHY THIS IS A CI JOB. The first thing an auditor does with a security package
is open the documents it cites. On 10 Sep 2026 this repo referenced roughly 20
documents that had never been written -- nine of them the "Primary doc" for a
threat-model domain carrying HIGH residual risk. A filename in a table reads as a
document that exists; a reference that 404s costs more credibility than an empty
row would. Nothing catches that by reading, so a machine does it.

An auditor's first move on a security package is to open the documents it cites.
A reference that 404s reads as either carelessness or concealment, and neither is
a good look on a handoff pack.

Only reports repo-relative paths that look like real file references — not URLs,
not prose, not code identifiers.
"""
import os, re, subprocess, sys, collections

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                      capture_output=True, text=True).stdout.strip()
os.chdir(ROOT)

tracked = set(subprocess.run(["git", "ls-files"], capture_output=True, text=True)
              .stdout.splitlines())
# also accept directories that exist
dirs = {os.path.dirname(p) for p in tracked if os.path.dirname(p)}

# backticked paths and markdown links that look like file references
FORGE_STD = {"Test.sol", "console.sol", "console2.sol", "Vm.sol", "StdInvariant.sol"}

# ⭐ Deliberate references to things that do not exist -- a planned document named
#    in a roadmap, or a filename quoted precisely BECAUSE it is missing. Each entry
#    needs a reason, so the list stays a record of known gaps rather than a place
#    to silence the check. An allow-list is a decision; a suppressed check is not.
ALLOWLIST_FILE = "scripts/ci/doc-refs-allowlist.txt"

def load_allowlist():
    allowed = set()
    if not os.path.exists(ALLOWLIST_FILE):
        return allowed
    for line in open(ALLOWLIST_FILE, encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        if line:
            allowed.add(line)
    return allowed

PAT = re.compile(r"`([A-Za-z0-9_./-]+\.(?:md|sol|js|ts|json|yaml|yml|toml|pdf|docx|sh))`"
                 r"|\]\(([A-Za-z0-9_./-]+\.(?:md|sol|js|ts|json|yaml|yml|toml|pdf|docx|sh))\)")

ALLOWED = load_allowlist()
missing = collections.defaultdict(list)
for doc in sorted(p for p in tracked if p.endswith(".md")):
    try:
        text = open(doc, encoding="utf-8", errors="replace").read()
    except OSError:
        continue
    for m in PAT.finditer(text):
        ref = (m.group(1) or m.group(2))
        if ref.startswith("./"):
            ref = ref[2:]
        if os.path.basename(ref) in FORGE_STD or ref in ALLOWED:
            continue
        if ref in tracked or ref in dirs:
            continue
        if os.path.exists(ref):          # untracked but present
            continue
        # resolve relative to the referring document
        rel = os.path.normpath(os.path.join(os.path.dirname(doc), ref))
        if rel in tracked or os.path.exists(rel):
            continue
        # ⭐ and by BASENAME anywhere in the tree: docs habitually cite
        #    "token/SRXToken.sol" for contracts/token/SRXToken.sol, which is a
        #    shorthand, not a broken link. Counting those as missing produced 283
        #    "failures" and buried the ~30 that are real.
        if any(t == ref or t.endswith("/" + ref) for t in tracked):
            continue
        missing[doc].append(ref)

total = sum(len(v) for v in missing.values())
print(f"  {total} unlisted reference(s) to files that do not exist, "
      f"across {len(missing)} document(s)")
print(f"  ({len(ALLOWED)} known gaps allow-listed in {ALLOWSHORT})\n"
      if (ALLOWSHORT := ALLOWLIST_FILE) else "")
if total:
    print("  Either create the file, correct the reference, or add it to the")
    print(f"  allow-list WITH A REASON: {ALLOWLIST_FILE}\n")
for doc, refs in sorted(missing.items()):
    print(f"  {doc}")
    for r in sorted(set(refs)):
        print(f"      -> {r}")
# forge-std imports resolve through foundry remappings, not the repo tree
sys.exit(1 if total else 0)
