/**
 * pre_mainnet_roles.js — Pre-mainnet role hardening
 *
 * Fixes role assignments on the TGE teststack that were left in a
 * "deployer-as-admin" state for testnet convenience. Must be run before
 * mainnet deployment to ensure the Timelock (not the deployer EOA) holds
 * GOVERNANCE_ROLE on every protocol contract.
 *
 * What this script does:
 *
 *  Step 1 — Grant GOVERNANCE_ROLE → Timelock on:
 *    - SRXStaking
 *    - FeeController
 *    - SRXTreasury
 *    - StabilisationFund
 *    (SRXToken already has this from deploy; GuardianModule already wired)
 *
 *  Step 2 — Revoke deployer EOA's GOVERNANCE_ROLE from:
 *    - SRXStaking
 *    - FeeController
 *    - SRXTreasury
 *    - StabilisationFund
 *
 *  Step 3 — Revoke deployer EOA's PROPOSER_ROLE from SRXTimelock
 *    (OZ TimelockController grants PROPOSER_ROLE to the admin address at
 *     deploy time as a bootstrap measure. On mainnet only SRXGovernor
 *     should hold this role.)
 *
 *  Step 4 — Final role verification:
 *    - Timelock has GOVERNANCE_ROLE on all 4 contracts ✓
 *    - Deployer does NOT have GOVERNANCE_ROLE on any contract ✓
 *    - Deployer does NOT have PROPOSER_ROLE on Timelock ✓
 *    - Governor still has PROPOSER_ROLE on Timelock ✓
 *
 * Prerequisites (.env):
 *   SRX_TOKEN_SEPOLIA_TGE
 *   TIMELOCK_SEPOLIA_TGE
 *   GOVERNOR_SEPOLIA_TGE
 *   STAKING_SEPOLIA_TGE
 *   FEE_CONTROLLER_SEPOLIA_TGE
 *   TREASURY_SEPOLIA_TGE
 *   STABILISATION_FUND_SEPOLIA_TGE
 *
 * Run:
 *   npx hardhat run scripts/ops/pre_mainnet_roles.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// ── Pass/fail tracking ─────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, err) {
  const msg = err?.message ?? String(err);
  console.log(`  ❌ ${label}`);
  console.log(`     ${msg.split("\n")[0]}`);
  failed++;
  failures.push({ label, msg });
}

function section(title) {
  const line = "─".repeat(Math.max(0, 56 - title.length));
  console.log(`\n── ${title} ${line}`);
}

function printSummary() {
  const total = passed + failed;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Pre-Mainnet Role Hardening`);
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    ✗ ${f.label}`));
  }
  console.log(`${"═".repeat(60)}\n`);
}

// ── Role constants ─────────────────────────────────────────────────────────────

const GOVERNANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNANCE_ROLE"));
const PROPOSER_ROLE   = ethers.keccak256(ethers.toUtf8Bytes("PROPOSER_ROLE"));

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (network.name !== "sepolia") {
    console.error(`\n  This script must run on sepolia.`);
    console.error(`  npx hardhat run scripts/ops/pre_mainnet_roles.js --network sepolia`);
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const suffix = "_SEPOLIA_TGE";

  // ── Load addresses ───────────────────────────────────────────────────────────

  const required = [
    `TIMELOCK${suffix}`,
    `GOVERNOR${suffix}`,
    `STAKING${suffix}`,
    `FEE_CONTROLLER${suffix}`,
    `TREASURY${suffix}`,
    `STABILISATION_FUND${suffix}`,
  ];

  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`\n  Fatal: Missing required env vars:`);
    missing.forEach(k => console.error(`    ${k}`));
    process.exit(1);
  }

  const timelockAddr  = process.env[`TIMELOCK${suffix}`];
  const governorAddr  = process.env[`GOVERNOR${suffix}`];
  const stakingAddr   = process.env[`STAKING${suffix}`];
  const feeAddr       = process.env[`FEE_CONTROLLER${suffix}`];
  const treasuryAddr  = process.env[`TREASURY${suffix}`];
  const ssfAddr       = process.env[`STABILISATION_FUND${suffix}`];

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Pre-Mainnet Role Hardening`);
  console.log(`  Network:  ${network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"═".repeat(60)}`);

  console.log(`\nAddresses:`);
  console.log(`  Timelock:          ${timelockAddr}`);
  console.log(`  Governor:          ${governorAddr}`);
  console.log(`  SRXStaking:        ${stakingAddr}`);
  console.log(`  FeeController:     ${feeAddr}`);
  console.log(`  SRXTreasury:       ${treasuryAddr}`);
  console.log(`  StabilisationFund: ${ssfAddr}`);

  // ── Attach contracts ─────────────────────────────────────────────────────────

  const staking   = await ethers.getContractAt("SRXStaking",        stakingAddr);
  const fee       = await ethers.getContractAt("FeeController",     feeAddr);
  const treasury  = await ethers.getContractAt("SRXTreasury",       treasuryAddr);
  const ssf       = await ethers.getContractAt("StabilisationFund", ssfAddr);
  const timelock  = await ethers.getContractAt("SRXTimelock",       timelockAddr);

  // ── Step 1: Grant GOVERNANCE_ROLE → Timelock ─────────────────────────────────

  section("Step 1 — Grant GOVERNANCE_ROLE → Timelock on all contracts");

  const contracts = [
    { name: "SRXStaking",        contract: staking  },
    { name: "FeeController",     contract: fee      },
    { name: "SRXTreasury",       contract: treasury },
    { name: "StabilisationFund", contract: ssf      },
  ];

  for (const { name, contract } of contracts) {
    try {
      const already = await contract.hasRole(GOVERNANCE_ROLE, timelockAddr);
      if (already) {
        pass(`${name}: Timelock already has GOVERNANCE_ROLE`);
      } else {
        await (await contract.grantRole(GOVERNANCE_ROLE, timelockAddr)).wait();
        pass(`${name}: GOVERNANCE_ROLE granted to Timelock`);
      }
    } catch (e) { fail(`Grant GOVERNANCE_ROLE on ${name}`, e); }
  }

  // ── Step 2: Revoke deployer's GOVERNANCE_ROLE ─────────────────────────────────

  section("Step 2 — Revoke deployer GOVERNANCE_ROLE from all contracts");

  for (const { name, contract } of contracts) {
    try {
      const hasRole = await contract.hasRole(GOVERNANCE_ROLE, deployer.address);
      if (!hasRole) {
        pass(`${name}: deployer already lacks GOVERNANCE_ROLE`);
      } else {
        await (await contract.revokeRole(GOVERNANCE_ROLE, deployer.address)).wait();
        pass(`${name}: GOVERNANCE_ROLE revoked from deployer`);
      }
    } catch (e) { fail(`Revoke GOVERNANCE_ROLE on ${name}`, e); }
  }

  // ── Step 3: Revoke deployer's PROPOSER_ROLE from Timelock ────────────────────

  section("Step 3 — Revoke deployer PROPOSER_ROLE from SRXTimelock");

  try {
    const hasProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);
    if (!hasProposer) {
      pass(`Timelock: deployer already lacks PROPOSER_ROLE`);
    } else {
      await (await timelock.revokeRole(PROPOSER_ROLE, deployer.address)).wait();
      pass(`Timelock: PROPOSER_ROLE revoked from deployer`);
    }
  } catch (e) { fail("Revoke PROPOSER_ROLE from deployer on Timelock", e); }

  // ── Step 4: Final role verification ──────────────────────────────────────────

  section("Step 4 — Final role verification");

  // 4a: Timelock has GOVERNANCE_ROLE on all 4 contracts
  for (const { name, contract } of contracts) {
    try {
      const ok = await contract.hasRole(GOVERNANCE_ROLE, timelockAddr);
      if (ok) {
        pass(`${name}: Timelock has GOVERNANCE_ROLE ✓`);
      } else {
        fail(`${name}: Timelock MISSING GOVERNANCE_ROLE`, new Error("Grant did not take effect"));
      }
    } catch (e) { fail(`Verify Timelock GOVERNANCE_ROLE on ${name}`, e); }
  }

  // 4b: Deployer does NOT have GOVERNANCE_ROLE on any contract
  for (const { name, contract } of contracts) {
    try {
      const has = await contract.hasRole(GOVERNANCE_ROLE, deployer.address);
      if (!has) {
        pass(`${name}: deployer does NOT have GOVERNANCE_ROLE ✓`);
      } else {
        fail(`${name}: deployer STILL has GOVERNANCE_ROLE`, new Error("Revoke did not take effect"));
      }
    } catch (e) { fail(`Verify deployer lacks GOVERNANCE_ROLE on ${name}`, e); }
  }

  // 4c: Deployer does NOT have PROPOSER_ROLE on Timelock
  try {
    const has = await timelock.hasRole(PROPOSER_ROLE, deployer.address);
    if (!has) {
      pass(`Timelock: deployer does NOT have PROPOSER_ROLE ✓`);
    } else {
      fail(`Timelock: deployer STILL has PROPOSER_ROLE`, new Error("Revoke did not take effect"));
    }
  } catch (e) { fail("Verify deployer lacks PROPOSER_ROLE on Timelock", e); }

  // 4d: Governor still has PROPOSER_ROLE on Timelock
  try {
    const has = await timelock.hasRole(PROPOSER_ROLE, governorAddr);
    if (has) {
      pass(`Timelock: Governor still has PROPOSER_ROLE ✓`);
    } else {
      fail(`Timelock: Governor MISSING PROPOSER_ROLE — governance broken`, new Error("Governor lost PROPOSER_ROLE"));
    }
  } catch (e) { fail("Verify Governor has PROPOSER_ROLE on Timelock", e); }

  // ── Summary ───────────────────────────────────────────────────────────────────

  printSummary();

  if (failed === 0) {
    console.log(`  ✅ All role assignments hardened for mainnet.`);
    console.log(`\n  Governance chain is now:`);
    console.log(`    Community vote → SRXGovernor → SRXTimelock → protocol contracts`);
    console.log(`\n  Deployer EOA no longer has elevated roles on any protocol contract.\n`);
  }
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err.message ?? err);
  process.exit(1);
});
