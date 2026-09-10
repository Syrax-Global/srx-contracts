# SRX Token — Deployment & TGE Execution Security (Round 6 / D2)

> Five contract-audit rounds verified the *code*. This document covers the surface they
> structurally could not: the act of deploying and executing the TGE. The contracts can be
> flawless and the launch can still be catastrophic — wrong key, wrong address, wrong order.

## The Threats (why this document exists)

| # | Threat | Impact | Mitigation |
|---|--------|--------|------------|
| D2-T1 | TGE sends supply to a wrong address (mis-set `.env`/`00_config` value) | 9–17% of supply lost irreversibly | `verify_tge_targets.js` + manifest (below) |
| D2-T2 | Deployer key compromise (single hot EOA key in `.env`) | Total launch control: genesis, all initial roles | Hardware-wallet signing (below) |
| D2-T3 | Genesis is multi-tx; reorg/interruption between steps | 10B SRX stranded in TGEDistributor mid-sequence | Recovery procedure (below) |
| D2-T4 | Wrong constructor args (LZ endpoint / oracle feed per chain) | Bridge or presale wired to a wrong/hostile contract | Per-chain arg manifest + verification |
| D2-T5 | Stale role-migration script run by mistake | Upgrade authority left on admin/deployer | Deprecate `pre_mainnet_roles.js` (below) |
| D2-T6 | Unverified bytecode on explorer | Users can't trust the contract; phishing surface | Etherscan source-match gate |

---

## D2-1 — Destination allowlist gate (closes D2-T1)

`06_execute_tge.js` distributes 10B SRX to destinations read from `.env`/`00_config.js`. A single
wrong value is unrecoverable. **New control:**

1. `cp deploy/addresses.example.json deploy/addresses.<network>.json`; fill EVERY field with the
   final, triple-checked, checksummed address. Keep the authoritative copy in the Safe records /
   `TGE_DEPLOYMENT_RUNBOOK.md` — the file is gitignored.
2. Run the read-only gate: `npx hardhat run scripts/verify/verify_tge_targets.js --network <net>`.
   It reconstructs the exact allocation set `06_execute_tge.js` will use, diffs every destination
   + amount + role holder against the manifest, re-asserts Σ == MAX_SUPPLY, and **exits non-zero on
   any mismatch**.
3. **Wire it as a hard pre-flight** — add to `06_execute_tge.js` immediately before `genesis()`:
   ```js
   const { execSync } = require("child_process");
   try { execSync(`npx hardhat run scripts/verify/verify_tge_targets.js --network ${network.name}`,
                  { stdio: "inherit" }); }
   catch { throw new Error("TGE target verification FAILED — aborting genesis."); }
   ```
   (Or run it manually and refuse to proceed unless it prints `✅ ALL TGE TARGETS VERIFIED`.)

**Negative test before trusting it:** temporarily change one `.env` destination, run the gate,
confirm it aborts with a clear mismatch. Then restore.

---

## D2-2 — Mainnet signing: retire the raw deployer key (closes D2-T2)

`hardhat.config.js` uses `accounts: [PRIVATE_KEY]` from `DEPLOYER_PRIVATE_KEY` in `.env` — a hot key
on the deploy machine, the *same* key configured for mainnet. This single key controls genesis and
every initial role. **For mainnet, do NOT use a raw private key.**

- **Use a hardware wallet for the mainnet deployer**: Frame (`frame.sh`) or a Ledger via
  `@nomicfoundation/hardhat-ledger`. Configure the mainnet network with the hardware account, not
  `PRIVATE_KEY`. The deployer signs each tx on-device; the key never touches disk.
- **Or use a one-time deployer EOA** generated air-gapped, funded with only the gas needed,
  whose roles are migrated to the Safe/Timelock immediately post-deploy and which is then
  permanently abandoned. Never reuse it.
- The deploy machine must be clean (fresh OS, no other secrets, no clipboard managers, offline
  except for RPC). Treat it as a key-ceremony environment (see `KEY_MANAGEMENT_CEREMONY.md`).
- `DEPLOYER_PRIVATE_KEY` stays testnet-only and must never hold mainnet value.

---

## D2-3 — Genesis atomicity & interruption recovery (closes D2-T3)

`06_execute_tge.js` runs four separate transactions: `genesis` → `distribute` → `triggerTGE`(×5) →
`notifyRewardAmount`. Between `genesis` and `distribute`, the TGEDistributor holds the entire 10B
supply. If the sequence is interrupted (reorg, gas spike, RPC drop, machine failure):

- **The state is recoverable, not lost.** `genesis` is one-shot (re-running aborts on
  `genesisComplete`). `distribute` is one-shot (`distributed` flag). `triggerTGE` is per-vault
  one-shot. The script's pre-flight checks already detect each completed step and refuse to repeat.
- **Recovery:** re-run `06_execute_tge.js`; its pre-flight skips completed steps and resumes. The
  TGEDistributor holding 10B mid-sequence is safe because `distribute()` is `onlyAdmin` and
  `recoverToken()` provides an admin escape hatch if distribution must be re-routed (only after
  `distributed`).
- **Deploy during low network congestion**, with adequate gas, on a finalized-block RPC, and confirm
  each tx to finality before the next. Do NOT batch-broadcast.
- After `genesis`, **immediately verify** `distributorBal == MAX_SUPPLY` (the script does this) before
  proceeding — a mismatch means abort.

---

## D2-4 — Constructor-argument verification (closes D2-T4)

Each contract's constructor wires it to external infrastructure that differs per chain:
- `SRXToken` / `SRXOFTNative` → LayerZero V2 **endpoint** (`LZ_ENDPOINTS` in `00_config.js`).
- `PreSaleRound` → Chainlink **feed addresses** (see `ORACLE_CONFIG.md`).

Before each deploy, verify the constructor args against the canonical per-chain registry
(`00_config.js` `LZ_ENDPOINTS`, `deploy/oracle-feeds.<network>.json`). A wrong LZ endpoint wires the
bridge to a hostile contract; a wrong feed mis-prices the entire presale. The presale deploy script
(`10_deploy_presale.js`) should assert each feed address against `oracle-feeds.<network>.json`
(see D7). Confirm `LZ_ENDPOINTS` against the official LayerZero V2 deployment list at deploy time.

---

## D2-5 — Deprecate the stale role script (closes D2-T5)

There are **two** role-migration scripts and they disagree:
- `scripts/ops/migrate_roles.js` (Round 4) — current. Handles `UPGRADER_ROLE` (the SC-TRUST-001
  split), Safe-batch generation, full topology. **This is the canonical tool.**
- `scripts/ops/pre_mainnet_roles.js` (legacy) — **stale.** It migrates only `GOVERNANCE_ROLE` and
  `PROPOSER_ROLE`; it predates the `UPGRADER_ROLE` split and does NOT migrate upgrade authority or
  `DEFAULT_ADMIN_ROLE`/`PAUSER_ROLE`. Running it and assuming "roles are hardened" would leave
  **upgrade authority on the admin/deployer** — exactly the SC-TRUST-001 hole Round 4 closed.

**Action:** add a loud deprecation banner to `pre_mainnet_roles.js` pointing to `migrate_roles.js`
+ `verify_roles.js`, or delete it. The role end-state is owned solely by `migrate_roles.js` →
`verify_roles.js`. Never trust a "roles done" claim that wasn't `verify_roles.js`-green.

---

## D2-6 — Bytecode verification & source-match (closes D2-T6)

Immediately after each mainnet deploy:
- Verify source on the chain's explorer (Etherscan V2 single key covers all chains —
  `hardhat.config.js`). Use `scripts/verify/verify_all.js`.
- Confirm the explorer shows a **green source-match** for every contract and that the compiler
  settings (0.8.24, viaIR, optimizer 200, cancun) match `hardhat.config.js` exactly. A metadata
  mismatch breaks verification and erodes trust.
- Publish the verified addresses (the canonical list) per `LAUNCH_DAY_PLAYBOOK.md` so users and
  exchanges can distinguish real SRX from impersonator tokens.

---

## Pre-Mainnet Deployment Gate (add to the runbook)

- [ ] `deploy/addresses.<network>.json` filled with final checksummed addresses, copy in Safe records
- [ ] `verify_tge_targets.js` prints `✅ ALL TGE TARGETS VERIFIED` (and aborts on an injected mismatch — tested)
- [ ] Mainnet deployer is a hardware wallet / abandoned one-time EOA, NOT `DEPLOYER_PRIVATE_KEY`
- [ ] Deploy machine is clean / key-ceremony grade
- [ ] LZ endpoints + oracle feeds verified against the per-chain registry
- [ ] `pre_mainnet_roles.js` deprecated; role end-state via `migrate_roles.js` → `verify_roles.js` only
- [ ] Every contract source-matched (green) on the explorer
- [ ] Canonical verified-address list published
