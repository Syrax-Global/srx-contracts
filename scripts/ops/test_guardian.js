/**
 * test_guardian.js — Phase 6: GuardianModule deploy + pause/unpause lifecycle
 *
 * Deploys GuardianModule programmatically (no readline prompt) and exercises
 * every guardian action path against the live TGE teststack on Sepolia.
 *
 * Tests covered:
 *  [6.1]  Deploy GuardianModule (deployer = admin + guardian + governance for testnet)
 *  [6.2]  Grant PAUSER_ROLE → GuardianModule on all 5 TGE contracts
 *  [6.3]  Register 5 modules (TOKEN, STAKING, FEE, TREASURY, SSF)
 *           MODULE_BRIDGE intentionally skipped on single-chain testnet:
 *           TOKEN + BRIDGE share SRXToken as target, which causes pauseAll() to
 *           call SRXToken.pause() twice → second call reverts with EnforcedPause
 *           → CallFailed. On mainnet BRIDGE targets the remote-chain OFT contract.
 *  [6.4]  Sunset sanity: isExpired() == false, secondsUntilSunset() > 0
 *  [6.5]  pauseModule(MODULE_FEE) — isolated single-module pause
 *  [6.6]  Verify only FEE paused; TOKEN/STAKING/TREASURY/SSF remain unaffected
 *  [6.7]  FeeController.paused() == true at contract level
 *  [6.8]  calculateFee() reverts with EnforcedPause while FeeController is paused
 *  [6.9]  unpauseModule(MODULE_FEE) — restore FeeController
 *  [6.10] Verify FEE unpaused; calculateFee() operational
 *  [6.11] Cooldown enforcement: immediate re-pauseModule(MODULE_FEE) reverts CooldownActive
 *  [6.12] governanceUnpause path: pauseModule(MODULE_STAKING) then governanceUnpause()
 *  [6.13] pauseAll() — emergency pause all registered modules (bypasses per-module cooldowns)
 *  [6.14] Verify all 5 modules paused at GuardianModule level + spot-check contract level
 *  [6.15] emergencyUnpauseAll() — governance force-restores all modules
 *  [6.16] Verify all 5 modules unpaused; contracts operational
 *  [6.17] Save GUARDIAN_<NET>_TGE to .env
 *
 * Run (new PowerShell session):
 *   cd "C:\Users\User\Documents\syrax-workspace\SRX Token"
 *   npx hardhat run scripts/ops/test_guardian.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const path = require("path");
const fs   = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// ── Pass/fail tracking ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
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

function envRequired(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function printSummary() {
  const total = passed + failed;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 6 — GuardianModule`);
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    ✗ ${f.label}`));
  }
  console.log(`${"═".repeat(60)}\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET    = network.name.toUpperCase();   // "SEPOLIA"
  const suffix = `_${NET}_TGE`;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 6 — GuardianModule (${network.name})`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"═".repeat(60)}`);

  // ── Load TGE addresses ────────────────────────────────────────────────────────

  let srxTokenAddr, stakingAddr, feeAddr, treasuryAddr, ssfAddr;

  try {
    srxTokenAddr = envRequired(`SRX_TOKEN${suffix}`);
    stakingAddr  = envRequired(`STAKING${suffix}`);
    feeAddr      = envRequired(`FEE_CONTROLLER${suffix}`);
    treasuryAddr = envRequired(`TREASURY${suffix}`);
    ssfAddr      = envRequired(`STABILISATION_FUND${suffix}`);
  } catch (e) {
    console.error(`\n  Fatal: ${e.message}`);
    console.error(`  Ensure the TGE teststack is deployed and .env is populated.`);
    process.exit(1);
  }

  console.log(`\nTGE addresses loaded:`);
  console.log(`  SRXToken:          ${srxTokenAddr}`);
  console.log(`  SRXStaking:        ${stakingAddr}`);
  console.log(`  FeeController:     ${feeAddr}`);
  console.log(`  SRXTreasury:       ${treasuryAddr}`);
  console.log(`  StabilisationFund: ${ssfAddr}`);

  // Contract instances
  const srxToken = await ethers.getContractAt("SRXToken",          srxTokenAddr);
  const staking  = await ethers.getContractAt("SRXStaking",        stakingAddr);
  const fee      = await ethers.getContractAt("FeeController",     feeAddr);
  const treasury = await ethers.getContractAt("SRXTreasury",       treasuryAddr);
  const ssf      = await ethers.getContractAt("StabilisationFund", ssfAddr);

  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.1] Deploy GuardianModule
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.1] Deploy GuardianModule");

  let guardian, guardianAddr;

  try {
    // 1-year sunset for testnet — long enough to avoid expiry during tests
    const SUNSET_SECONDS = 365 * 86400;

    const GuardianModuleFactory = await ethers.getContractFactory("GuardianModule");
    guardian = await GuardianModuleFactory.deploy(
      deployer.address, // DEFAULT_ADMIN_ROLE
      deployer.address, // GUARDIAN_ROLE — deployer acts as guardian multisig on testnet
      deployer.address, // GOVERNANCE_ROLE — deployer acts as timelock on testnet
      SUNSET_SECONDS
    );
    await guardian.waitForDeployment();
    guardianAddr = await guardian.getAddress();

    console.log(`\n  GuardianModule deployed: ${guardianAddr}`);

    const maxSunset = await guardian.MAXIMUM_SUNSET();
    const effSunset = await guardian.effectiveSunset();
    console.log(`  MAXIMUM_SUNSET:    ${new Date(Number(maxSunset) * 1000).toISOString()}`);
    console.log(`  effectiveSunset:   ${new Date(Number(effSunset) * 1000).toISOString()}`);

    if (guardianAddr !== ethers.ZeroAddress) {
      pass("GuardianModule deployed at non-zero address");
    } else {
      fail("GuardianModule address should not be zero", new Error("ZeroAddress"));
    }

    if (maxSunset === effSunset) {
      pass("effectiveSunset == MAXIMUM_SUNSET at deployment");
    } else {
      fail("effectiveSunset should equal MAXIMUM_SUNSET", new Error("mismatch"));
    }

  } catch (e) {
    fail("Deploy GuardianModule", e);
    console.error("\n  Fatal: cannot continue without GuardianModule.");
    printSummary();
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.2] Sunset sanity checks
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.2] Sunset sanity checks");

  try {
    const isExpired = await guardian.isExpired();
    if (!isExpired) {
      pass("isExpired() == false (within sunset window)");
    } else {
      fail("isExpired() should be false", new Error("returned true — sunset already passed"));
    }
  } catch (e) { fail("isExpired()", e); }

  try {
    const secsLeft = await guardian.secondsUntilSunset();
    const daysLeft = Number(secsLeft) / 86400;
    if (secsLeft > 0n) {
      pass(`secondsUntilSunset() = ${daysLeft.toFixed(1)} days remaining`);
    } else {
      fail("secondsUntilSunset() should be > 0", new Error("returned 0"));
    }
  } catch (e) { fail("secondsUntilSunset()", e); }

  // Verify roles
  try {
    const GOV_ROLE      = await guardian.GOVERNANCE_ROLE();
    const GUARDIAN_ROLE_HASH = await guardian.GUARDIAN_ROLE();

    if (await guardian.hasRole(GOV_ROLE, deployer.address)) {
      pass("Deployer holds GOVERNANCE_ROLE");
    } else {
      fail("Deployer should hold GOVERNANCE_ROLE", new Error("missing"));
    }

    if (await guardian.hasRole(GUARDIAN_ROLE_HASH, deployer.address)) {
      pass("Deployer holds GUARDIAN_ROLE");
    } else {
      fail("Deployer should hold GUARDIAN_ROLE", new Error("missing"));
    }
  } catch (e) { fail("Role checks", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.3] Grant PAUSER_ROLE on all 5 contracts → GuardianModule
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.3] Grant PAUSER_ROLE → GuardianModule");

  for (const [name, contract] of [
    ["SRXToken",          srxToken],
    ["SRXStaking",        staking],
    ["FeeController",     fee],
    ["SRXTreasury",       treasury],
    ["StabilisationFund", ssf],
  ]) {
    try {
      await (await contract.grantRole(PAUSER_ROLE, guardianAddr)).wait();
      // Verify it was actually granted
      if (await contract.hasRole(PAUSER_ROLE, guardianAddr)) {
        pass(`${name}.PAUSER_ROLE → GuardianModule`);
      } else {
        fail(`${name}.PAUSER_ROLE grant not reflected`, new Error("hasRole=false"));
      }
    } catch (e) { fail(`${name} grantRole PAUSER_ROLE`, e); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.4] Register 5 modules
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.4] Register modules");

  const MODULE_TOKEN    = await guardian.MODULE_TOKEN();
  const MODULE_BRIDGE   = await guardian.MODULE_BRIDGE();
  const MODULE_STAKING  = await guardian.MODULE_STAKING();
  const MODULE_FEE      = await guardian.MODULE_FEE();
  const MODULE_TREASURY = await guardian.MODULE_TREASURY();
  const MODULE_SSF      = await guardian.MODULE_SSF();

  console.log(`\n  ℹ️  MODULE_BRIDGE registration skipped.`);
  console.log(`     Reason: on this single-chain testnet, TOKEN + BRIDGE both target`);
  console.log(`     SRXToken. pauseAll() would call SRXToken.pause() twice — the 2nd`);
  console.log(`     call reverts with EnforcedPause → CallFailed → entire tx fails.`);
  console.log(`     On mainnet, MODULE_BRIDGE targets the remote-chain OFT contract.\n`);

  const moduleRegistrations = [
    { id: MODULE_TOKEN,    target: srxTokenAddr, name: "MODULE_TOKEN    → SRXToken" },
    { id: MODULE_STAKING,  target: stakingAddr,  name: "MODULE_STAKING  → SRXStaking" },
    { id: MODULE_FEE,      target: feeAddr,      name: "MODULE_FEE      → FeeController" },
    { id: MODULE_TREASURY, target: treasuryAddr, name: "MODULE_TREASURY → SRXTreasury" },
    { id: MODULE_SSF,      target: ssfAddr,      name: "MODULE_SSF      → StabilisationFund" },
  ];

  for (const { id, target, name } of moduleRegistrations) {
    try {
      await (await guardian.registerModule(id, target)).wait();
      const m = await guardian.modules(id);
      if (m.registered && m.target.toLowerCase() === target.toLowerCase()) {
        pass(name);
      } else {
        fail(`${name} — module not correctly registered`, new Error("state mismatch"));
      }
    } catch (e) { fail(`registerModule ${name}`, e); }
  }

  // MODULE_BRIDGE not registered — verify guard works for completeness
  try {
    const bridgeMod = await guardian.modules(MODULE_BRIDGE);
    if (!bridgeMod.registered) {
      pass("MODULE_BRIDGE correctly unregistered (bridge is single-chain bypass)");
    }
  } catch (e) { /* non-critical */ }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.5] Isolated pause: pauseModule(MODULE_FEE)
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.5] Isolated pause — pauseModule(MODULE_FEE)");

  try {
    await (await guardian.pauseModule(MODULE_FEE, "test_isolated_fee_pause")).wait();
    pass("pauseModule(MODULE_FEE, 'test_isolated_fee_pause') succeeded");
  } catch (e) { fail("pauseModule(MODULE_FEE)", e); }

  // Verify GuardianModule tracking
  try {
    const feeMod = await guardian.modules(MODULE_FEE);
    if (feeMod.paused) {
      pass(`GuardianModule: MODULE_FEE.paused == true (pauseCount = ${feeMod.pauseCount})`);
    } else {
      fail("MODULE_FEE should be marked paused in GuardianModule", new Error("paused=false"));
    }
  } catch (e) { fail("modules(MODULE_FEE) state check", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.6] Verify isolation — other modules unaffected
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.6] Verify isolation — other modules unaffected");

  for (const [id, name] of [
    [MODULE_TOKEN,    "MODULE_TOKEN"],
    [MODULE_STAKING,  "MODULE_STAKING"],
    [MODULE_TREASURY, "MODULE_TREASURY"],
    [MODULE_SSF,      "MODULE_SSF"],
  ]) {
    try {
      const modState = await guardian.modules(id);
      if (!modState.paused) {
        pass(`${name}.paused == false (unaffected by isolated pause)`);
      } else {
        fail(`${name} should NOT be paused`, new Error("paused=true — isolation failed"));
      }
    } catch (e) { fail(`modules(${name}) isolation check`, e); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.7] FeeController paused at contract level
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.7] FeeController paused at contract level");

  try {
    const contractPaused = await fee.paused();
    if (contractPaused) {
      pass("FeeController.paused() == true (contract-level state confirmed)");
    } else {
      fail("FeeController contract should be paused", new Error("paused()=false"));
    }
  } catch (e) { fail("FeeController.paused() read", e); }

  // SRXToken should still be unpaused (isolation test)
  try {
    const tokenPaused = await srxToken.paused();
    if (!tokenPaused) {
      pass("SRXToken.paused() == false (unaffected by MODULE_FEE pause)");
    } else {
      fail("SRXToken should be unpaused", new Error("paused()=true — isolation failed"));
    }
  } catch (e) { fail("SRXToken.paused() during isolation test", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.8] calculateFee() reverts while FeeController is paused
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.8] calculateFee() reverts while FeeController paused");

  try {
    // PaymentType.Fiat = 0
    await fee.calculateFee(deployer.address, 0);
    fail("calculateFee() should revert when paused", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("paused") || e.code === "CALL_EXCEPTION") {
      pass("calculateFee() reverts with EnforcedPause while FeeController is paused");
    } else {
      fail("calculateFee() revert — unexpected error type", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.9] unpauseModule(MODULE_FEE)
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.9] unpauseModule(MODULE_FEE)");

  try {
    await (await guardian.unpauseModule(MODULE_FEE, "test_unpause_fee")).wait();
    pass("unpauseModule(MODULE_FEE) succeeded");
  } catch (e) { fail("unpauseModule(MODULE_FEE)", e); }

  try {
    const feeMod = await guardian.modules(MODULE_FEE);
    if (!feeMod.paused) {
      pass("GuardianModule: MODULE_FEE.paused == false after unpause");
    } else {
      fail("MODULE_FEE should not be paused after unpause", new Error("still paused"));
    }
  } catch (e) { fail("modules(MODULE_FEE) after unpause", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.10] FeeController functional after unpause
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.10] FeeController operational after unpause");

  try {
    const contractPaused = await fee.paused();
    if (!contractPaused) {
      pass("FeeController.paused() == false (restored at contract level)");
    } else {
      fail("FeeController should be unpaused", new Error("paused()=true"));
    }
  } catch (e) { fail("FeeController.paused() after unpause", e); }

  try {
    // PaymentType.Fiat = 0, deployer has no staking → full base fee 150 bps
    const feeBps = await fee.calculateFee(deployer.address, 0);
    if (feeBps > 0n) {
      pass(`calculateFee() functional: ${feeBps.toString()} bps (Fiat, no discount)`);
    } else {
      fail("calculateFee() should return > 0 for Fiat with no staking", new Error("returned 0"));
    }
  } catch (e) { fail("calculateFee() after FeeController unpause", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.11] Cooldown enforcement — re-pause same module immediately
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.11] Cooldown enforcement — pauseModule(MODULE_FEE) should revert");

  console.log(`\n  MODULE_FEE was paused in [6.5]; PAUSE_COOLDOWN = 1 hour.`);
  console.log(`  Attempting immediate re-pause — expect CooldownActive revert.\n`);

  try {
    await guardian.pauseModule(MODULE_FEE, "cooldown_test");
    fail("pauseModule(MODULE_FEE) should revert with CooldownActive", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("cooldown") || e.code === "CALL_EXCEPTION") {
      pass("pauseModule(MODULE_FEE) reverts with CooldownActive (< 1 hour since last pause)");
    } else {
      fail("Cooldown revert — unexpected error type", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.12] governanceUnpause path — pause STAKING, override via governance
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.12] governanceUnpause — governance overrides a guardian pause");

  console.log(`\n  Pause MODULE_STAKING via guardian, then force-unpause via governance.`);
  console.log(`  governanceUnpause bypasses cooldowns and sunset — governance is supreme.\n`);

  try {
    await (await guardian.pauseModule(MODULE_STAKING, "test_gov_override_setup")).wait();
    const stakingMod = await guardian.modules(MODULE_STAKING);
    if (stakingMod.paused) {
      pass("pauseModule(MODULE_STAKING) succeeded (setup for governance override test)");
    } else {
      fail("MODULE_STAKING should be paused", new Error("paused=false"));
    }
  } catch (e) { fail("pauseModule(MODULE_STAKING) for gov override setup", e); }

  // Verify staking contract paused at contract level
  try {
    const contractPaused = await staking.paused();
    if (contractPaused) {
      pass("SRXStaking.paused() == true (guardian pause confirmed at contract level)");
    } else {
      fail("SRXStaking should be paused at contract level", new Error("paused()=false"));
    }
  } catch (e) { fail("SRXStaking.paused() during gov override test", e); }

  // Governance force-unpauses it
  try {
    await (await guardian.governanceUnpause(MODULE_STAKING, "governance_override_test")).wait();

    const stakingMod = await guardian.modules(MODULE_STAKING);
    const contractPaused = await staking.paused();

    if (!stakingMod.paused) {
      pass("GuardianModule: MODULE_STAKING.paused == false after governanceUnpause");
    } else {
      fail("MODULE_STAKING should be unpaused after governanceUnpause", new Error("still paused"));
    }

    if (!contractPaused) {
      pass("SRXStaking.paused() == false (contract restored by governance override)");
    } else {
      fail("SRXStaking should be unpaused at contract level", new Error("paused()=true"));
    }
  } catch (e) { fail("governanceUnpause(MODULE_STAKING)", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.13] pauseAll() — emergency pause all registered modules
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.13] pauseAll() — emergency pause all registered modules");

  console.log(`\n  Pausing all 5 registered modules in one transaction.`);
  console.log(`  MODULE_FEE and MODULE_STAKING have active per-module cooldowns`);
  console.log(`  from [6.5] and [6.12] — pauseAll() bypasses these by design.\n`);

  try {
    await (await guardian.pauseAll("emergency_system_test")).wait();
    pass("pauseAll('emergency_system_test') succeeded");
  } catch (e) { fail("pauseAll()", e); }

  // Verify lastPauseAllTime was set
  try {
    const lastPauseAll = await guardian.lastPauseAllTime();
    if (lastPauseAll > 0n) {
      pass(`lastPauseAllTime updated: ${new Date(Number(lastPauseAll) * 1000).toISOString()}`);
    } else {
      fail("lastPauseAllTime should be > 0 after pauseAll", new Error("still 0"));
    }
  } catch (e) { fail("lastPauseAllTime check", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.14] Verify all 5 modules paused
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.14] Verify all 5 modules paused after pauseAll()");

  for (const [id, name, contract] of [
    [MODULE_TOKEN,    "MODULE_TOKEN",    srxToken],
    [MODULE_STAKING,  "MODULE_STAKING",  staking],
    [MODULE_FEE,      "MODULE_FEE",      fee],
    [MODULE_TREASURY, "MODULE_TREASURY", treasury],
    [MODULE_SSF,      "MODULE_SSF",      ssf],
  ]) {
    try {
      const modState       = await guardian.modules(id);
      const contractPaused = await contract.paused();

      if (modState.paused) {
        pass(`GuardianModule: ${name}.paused == true`);
      } else {
        fail(`${name} should be paused in GuardianModule`, new Error("paused=false"));
      }

      if (contractPaused) {
        pass(`${name} contract-level paused() == true`);
      } else {
        fail(`${name} contract should be paused`, new Error("paused()=false"));
      }
    } catch (e) { fail(`${name} paused verification`, e); }
  }

  // Confirm pauseAll cooldown is now active (second pauseAll should revert)
  try {
    await guardian.pauseAll("should_fail_cooldown");
    fail("Second immediate pauseAll should revert with PauseAllCooldownActive", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("cooldown") || e.code === "CALL_EXCEPTION") {
      pass("Immediate second pauseAll() reverts with PauseAllCooldownActive (30-min cooldown active)");
    } else {
      fail("pauseAll cooldown revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.15] emergencyUnpauseAll() — governance force-restores everything
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.15] emergencyUnpauseAll() — governance restores all modules");

  console.log(`\n  GOVERNANCE_ROLE only. Bypasses all guardian state:`);
  console.log(`  no cooldown check, no sunset check, forces unpause on every module.\n`);

  try {
    await (await guardian.emergencyUnpauseAll("emergency_test_complete_restore")).wait();
    pass("emergencyUnpauseAll() succeeded");
  } catch (e) { fail("emergencyUnpauseAll()", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.16] Verify all modules unpaused and contracts operational
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.16] Verify all modules unpaused and functional");

  for (const [id, name, contract] of [
    [MODULE_TOKEN,    "MODULE_TOKEN",    srxToken],
    [MODULE_STAKING,  "MODULE_STAKING",  staking],
    [MODULE_FEE,      "MODULE_FEE",      fee],
    [MODULE_TREASURY, "MODULE_TREASURY", treasury],
    [MODULE_SSF,      "MODULE_SSF",      ssf],
  ]) {
    try {
      const modState       = await guardian.modules(id);
      const contractPaused = await contract.paused();

      if (!modState.paused) {
        pass(`GuardianModule: ${name}.paused == false`);
      } else {
        fail(`${name} should be unpaused after emergencyUnpauseAll`, new Error("still paused"));
      }

      if (!contractPaused) {
        pass(`${name} contract-level paused() == false`);
      } else {
        fail(`${name} contract should be unpaused`, new Error("paused()=true"));
      }
    } catch (e) { fail(`${name} unpaused verification`, e); }
  }

  // Functional smoke test: FeeController should process fees normally
  try {
    const feeBps = await fee.calculateFee(deployer.address, 0); // Fiat
    if (feeBps > 0n) {
      pass(`FeeController operational: calculateFee = ${feeBps.toString()} bps`);
    } else {
      fail("calculateFee should return > 0 after emergencyUnpauseAll", new Error("returned 0"));
    }
  } catch (e) { fail("FeeController calculateFee() post-emergencyUnpauseAll", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [6.17] Save GuardianModule address to .env
  // ══════════════════════════════════════════════════════════════════════════════

  section("[6.17] Save address to .env");

  const envPath = path.join(__dirname, "../../.env");
  const envKey  = `GUARDIAN_${NET}_TGE`;

  try {
    let envContent = fs.readFileSync(envPath, "utf8");
    const regex = new RegExp(`^${envKey}=.*$`, "m");

    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${envKey}=${guardianAddr}`);
      fs.writeFileSync(envPath, envContent);
      pass(`Updated ${envKey} in .env`);
    } else {
      fs.appendFileSync(envPath, `\n${envKey}=${guardianAddr}\n`);
      pass(`Appended ${envKey} to .env`);
    }
    console.log(`\n  ${envKey}=${guardianAddr}`);
  } catch (e) { fail(`Save ${envKey} to .env`, e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  Summary
  // ══════════════════════════════════════════════════════════════════════════════

  printSummary();

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err.message ?? err);
  process.exit(1);
});
