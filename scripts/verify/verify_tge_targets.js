/**
 * verify_tge_targets.js — TGE destination-allowlist gate (Round 6 / D2)
 *
 * The single scariest non-code risk in the whole launch: 06_execute_tge.js sends
 * billions of SRX to destinations read from .env / 00_config.js. One wrong env var
 * → 9–17% of supply sent irreversibly to a wrong address. No on-chain code can catch it.
 *
 * This script is the last line of defence. It reconstructs the EXACT allocation set
 * 06_execute_tge.js will use, diffs every destination + amount against a pre-committed,
 * triple-checked manifest (deploy/addresses.<network>.json), and EXITS NON-ZERO on any
 * mismatch. Run it immediately before 06_execute_tge.js — and wire it as a hard
 * pre-flight inside that script (see the patch note in DEPLOYMENT_SECURITY.md).
 *
 * It is READ-ONLY (no transactions). It also re-asserts the supply invariant
 * (Σ allocations == MAX_SUPPLY) independently of the contract.
 *
 * Setup: cp deploy/addresses.example.json deploy/addresses.<network>.json, fill every
 * field with the FINAL checksummed addresses, keep the authoritative copy in your Safe
 * records. The file is gitignored.
 *
 * Run: npx hardhat run scripts/verify/verify_tge_targets.js --network ethereum
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ALLOCATIONS, WALLETS } = require("../deploy/00_config");
require("dotenv").config();

const NET = network.name.toUpperCase();
const MAX_SUPPLY = ethers.parseUnits("10000000000", 18);

function envOpt(key) {
  return process.env[`${key}_${NET}`] || process.env[key] || null;
}

function ck(addr, label) {
  if (!addr) throw new Error(`Missing address for ${label}`);
  try { return ethers.getAddress(addr); }
  catch { throw new Error(`Invalid address for ${label}: ${addr}`); }
}

async function main() {
  // ── Load the manifest ──────────────────────────────────────────────────────
  // ⛔ WAS `path.join(__dirname, "..", "deploy", ...)`. __dirname is scripts/verify,
  //    so that resolved to scripts/deploy/ — a directory that does not exist. The
  //    manifest and its example live in deploy/ at the repo root, which is where
  //    this script's own error message tells you to create it from. The gate
  //    failed closed (exit 1) rather than passing falsely, but the documented
  //    "last line of defence" against sending billions to a wrong address could
  //    never actually run.
  const manifestPath = path.join(__dirname, "..", "..", "deploy", `addresses.${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    console.error(`\n❌ No manifest at ${manifestPath}`);
    console.error(`   Create it from deploy/addresses.example.json with the FINAL addresses.`);
    process.exit(1);
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // ── Reconstruct the live allocation set EXACTLY as 06_execute_tge.js builds it ──
  const stakingAddr = envOpt("STAKING");
  const live = {
    Founders:          { destination: ck(envOpt("VESTING_FOUNDERS"),  "VESTING_FOUNDERS"),  amount: ALLOCATIONS.founders },
    CoreTeam:          { destination: ck(envOpt("VESTING_CORE_TEAM"), "VESTING_CORE_TEAM"), amount: ALLOCATIONS.coreTeam },
    SeedInvestors:     { destination: ck(envOpt("VESTING_SEED"),      "VESTING_SEED"),      amount: ALLOCATIONS.seedInvestors },
    Presale:           { destination: ck(envOpt("VESTING_PRESALE"),   "VESTING_PRESALE"),   amount: ALLOCATIONS.presale },
    EcosystemDAO:      { destination: ck(envOpt("VESTING_ECOSYSTEM"), "VESTING_ECOSYSTEM"), amount: ALLOCATIONS.ecosystem },
    Liquidity:         { destination: ck(WALLETS.liquidity,           "WALLETS.liquidity"), amount: ALLOCATIONS.liquidity },
    Staking:           { destination: ck(stakingAddr || WALLETS.staking, "STAKING/WALLETS.staking"), amount: ALLOCATIONS.staking },
    Treasury:          { destination: ck(envOpt("TREASURY"),          "TREASURY"),          amount: ALLOCATIONS.treasury },
    StabilisationFund: { destination: ck(envOpt("STABILISATION_FUND"),"STABILISATION_FUND"),amount: ALLOCATIONS.strategic },
  };

  console.log(`\n🎯 TGE target verification — network: ${network.name}`);
  console.log(`   manifest: ${manifestPath}\n`);

  let failures = 0;
  let sum = 0n;

  // ── 1. Each destination + amount must match the manifest ───────────────────
  for (const [label, { destination, amount }] of Object.entries(live)) {
    sum += amount;
    const exp = m.tgeAllocations?.[label];
    if (!exp) { console.log(`   ❌ ${label}: not in manifest`); failures++; continue; }

    const expDest = ck(exp.destination, `manifest.${label}.destination`);
    const expAmt  = ethers.parseUnits(String(exp.amountSRX), 18);

    const destOk = destination === expDest;
    const amtOk  = amount === expAmt;
    if (destOk && amtOk) {
      console.log(`   ✅ ${label}: ${destination} (${ethers.formatUnits(amount, 18)} SRX)`);
    } else {
      failures++;
      if (!destOk) console.log(`   ❌ ${label} DESTINATION mismatch: live ${destination} ≠ manifest ${expDest}`);
      if (!amtOk)  console.log(`   ❌ ${label} AMOUNT mismatch: live ${ethers.formatUnits(amount,18)} ≠ manifest ${exp.amountSRX}`);
    }
  }

  // ── 2. Supply invariant ────────────────────────────────────────────────────
  if (sum === MAX_SUPPLY) {
    console.log(`\n   ✅ Σ allocations = 10,000,000,000 SRX (== MAX_SUPPLY)`);
  } else {
    failures++;
    console.log(`\n   ❌ Σ allocations = ${ethers.formatUnits(sum,18)} SRX ≠ MAX_SUPPLY (10,000,000,000)`);
  }

  // ── 3. Role holders must match the manifest (catches admin/timelock misconfig) ──
  const roleChecks = [
    ["admin", WALLETS.admin],
    ["timelock", envOpt("TIMELOCK")],
    ["governor", envOpt("GOVERNOR")],
    ["guardianModule", envOpt("GUARDIAN_MODULE")],
  ];
  console.log("");
  for (const [label, liveAddr] of roleChecks) {
    const expRaw = m.roles?.[label];
    if (!expRaw || expRaw === "0x0000000000000000000000000000000000000000") {
      console.log(`   ⚠️  ${label}: not pinned in manifest — skipping (pin it before mainnet)`);
      continue;
    }
    if (!liveAddr) { console.log(`   ⚠️  ${label}: not set in env/config — skipping`); continue; }
    if (ck(liveAddr, label) === ck(expRaw, `manifest.roles.${label}`)) {
      console.log(`   ✅ role ${label}: ${ck(liveAddr,label)}`);
    } else {
      failures++;
      console.log(`   ❌ role ${label} mismatch: live ${ck(liveAddr,label)} ≠ manifest ${ck(expRaw,label)}`);
    }
  }

  console.log(`\n──────────────────────────────────────────────`);
  if (failures > 0) {
    console.log(`❌ ${failures} mismatch(es) — TGE MUST NOT PROCEED. Fix .env / config or the manifest.`);
    process.exit(1);
  }
  console.log(`✅ ALL TGE TARGETS VERIFIED against the manifest. Safe to proceed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
