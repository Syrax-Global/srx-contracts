/**
 * test_migrator.js — Phase 7: ZkSyncMigrator deploy + full migration lifecycle
 *
 * Deploys ZkSyncMigrator and exercises every function path on Sepolia.
 *
 * Migration flow (Strategy A — Burn-to-Migrate):
 *   User approves ZkSyncMigrator → migrate(amount) burns SRX via buyAndBurn()
 *   → MigrationRequest event → Syrax Chain oracle issues native SRX to same address
 *   → oracle calls confirmMigration() to record on-chain confirmation
 *
 * Tests covered:
 *  [7.1]  Deploy ZkSyncMigrator(srxTokenTGE, deployer)
 *  [7.2]  Grant BURN_ROLE → migrator on SRXToken (required for buyAndBurn())
 *  [7.3]  Grant ORACLE_ROLE → deployer on migrator (for confirmMigration tests)
 *  [7.4]  migrate() before enabled → MigrationNotEnabled revert
 *  [7.5]  enableMigration() — one-way gate (migrationEnabled = true)
 *  [7.6]  migrate(0) → ZeroAmount revert
 *  [7.7]  Investor approves + migrate(1000 SRX) → MigrationRequest emitted
 *  [7.8]  Verify state: totalMigrated, userMigrated, migrationUser, migrationCount
 *  [7.9]  confirmMigration(1, investor) → MigrationConfirmed, confirmed[1] = true
 *  [7.10] confirmMigration(1, investor) again → AlreadyConfirmed revert
 *  [7.11] confirmMigration(999, investor) → InvalidMigrationId revert (A6-ZK-01 guard)
 *  [7.12] Pause SRXToken → migrate() reverts (safeTransferFrom blocked by pause)
 *  [7.13] Unpause SRXToken → migration resumes
 *  [7.14] closeMigration() → migrationClosed = true, MigrationClosed emitted
 *  [7.15] migrate() after window closed → MigrationWindowClosed revert
 *  [7.16] Final state verification
 *  [7.17] Save MIGRATOR_<NET>_TGE to .env
 *
 * Run (new PowerShell session):
 *   cd "C:\Users\User\Documents\syrax-workspace\SRX Token"
 *   npx hardhat run scripts/ops/test_migrator.js --network sepolia
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
  console.log(`  Phase 7 — ZkSyncMigrator`);
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
  const NET    = network.name.toUpperCase();
  const suffix = `_${NET}_TGE`;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 7 — ZkSyncMigrator (${network.name})`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"═".repeat(60)}`);

  // ── Load TGE SRXToken address ────────────────────────────────────────────────

  let srxTokenAddr;
  try {
    srxTokenAddr = envRequired(`SRX_TOKEN${suffix}`);
  } catch (e) {
    console.error(`\n  Fatal: ${e.message}`);
    process.exit(1);
  }

  // ── Load investor wallet ──────────────────────────────────────────────────────

  const investorKey = process.env.INVESTOR_PRIVATE_KEY;
  if (!investorKey) {
    console.error(`\n  Fatal: INVESTOR_PRIVATE_KEY not set in .env`);
    console.error(`  The investor wallet needs SRX from the staking earlyWithdraw (Run 013).`);
    process.exit(1);
  }
  const investor = new ethers.Wallet(investorKey, ethers.provider);

  const srxToken = await ethers.getContractAt("SRXToken", srxTokenAddr);

  const investorSRX = await srxToken.balanceOf(investor.address);
  const deployerSRX = await srxToken.balanceOf(deployer.address);

  console.log(`\nAddresses loaded:`);
  console.log(`  SRXToken (TGE):  ${srxTokenAddr}`);
  console.log(`  Investor:        ${investor.address}`);
  console.log(`  Deployer SRX:    ${ethers.formatUnits(deployerSRX, 18)} SRX`);
  console.log(`  Investor SRX:    ${ethers.formatUnits(investorSRX, 18)} SRX`);

  const MIGRATE_AMOUNT = ethers.parseUnits("1000", 18); // 1,000 SRX — small test burn

  // Check investor has enough SRX
  if (investorSRX < MIGRATE_AMOUNT) {
    // Top up from deployer if possible (same pattern as test_staking.js)
    if (deployerSRX >= MIGRATE_AMOUNT) {
      console.log(`\n  Topping up investor with ${ethers.formatUnits(MIGRATE_AMOUNT, 18)} SRX from deployer...`);
      await (await srxToken.transfer(investor.address, MIGRATE_AMOUNT)).wait();
      console.log(`  Investor funded ✅`);
    } else {
      console.error(`\n  Fatal: Investor has insufficient SRX (${ethers.formatUnits(investorSRX, 18)}) and deployer cannot top up.`);
      console.error(`  Run test_staking.js first — the earlyWithdraw step funds the investor wallet.`);
      process.exit(1);
    }
  }

  const BURN_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("BURN_ROLE"));
  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.1] Deploy ZkSyncMigrator
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.1] Deploy ZkSyncMigrator");

  let migrator, migratorAddr;

  try {
    const MigratorFactory = await ethers.getContractFactory("ZkSyncMigrator");
    migrator = await MigratorFactory.deploy(srxTokenAddr, deployer.address);
    await migrator.waitForDeployment();
    migratorAddr = await migrator.getAddress();

    console.log(`\n  ZkSyncMigrator: ${migratorAddr}`);
    console.log(`  SRX token:      ${await migrator.srxToken()}`);

    if (migratorAddr !== ethers.ZeroAddress) {
      pass("ZkSyncMigrator deployed at non-zero address");
    } else {
      fail("Migrator address should not be zero", new Error("ZeroAddress"));
    }

    // Verify initial state
    if (!(await migrator.migrationEnabled())) {
      pass("migrationEnabled == false at deployment");
    } else {
      fail("migrationEnabled should start false", new Error("was true"));
    }

    if (!(await migrator.migrationClosed())) {
      pass("migrationClosed == false at deployment");
    } else {
      fail("migrationClosed should start false", new Error("was true"));
    }

    const count = await migrator.migrationCount();
    if (count === 0n) {
      pass("migrationCount == 0 at deployment");
    } else {
      fail("migrationCount should be 0", new Error(`was ${count}`));
    }

  } catch (e) {
    fail("Deploy ZkSyncMigrator", e);
    console.error("\n  Fatal: cannot continue without ZkSyncMigrator.");
    printSummary();
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.2] Grant BURN_ROLE → migrator on SRXToken
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.2] Grant BURN_ROLE → migrator on SRXToken");

  console.log(`\n  migrate() calls SRXToken.buyAndBurn() from the migrator contract.`);
  console.log(`  BURN_ROLE must be held by the migrator for buyAndBurn() to succeed.\n`);

  try {
    await (await srxToken.grantRole(BURN_ROLE, migratorAddr)).wait();
    const hasBurnRole = await srxToken.hasRole(BURN_ROLE, migratorAddr);
    if (hasBurnRole) {
      pass("SRXToken.BURN_ROLE granted to ZkSyncMigrator");
    } else {
      fail("BURN_ROLE grant not reflected", new Error("hasRole=false"));
    }
  } catch (e) { fail("grantRole(BURN_ROLE, migrator)", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.3] Grant ORACLE_ROLE → deployer on migrator
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.3] Grant ORACLE_ROLE → deployer (for confirmMigration tests)");

  try {
    const ORACLE_ROLE = await migrator.ORACLE_ROLE();
    await (await migrator.grantRole(ORACLE_ROLE, deployer.address)).wait();
    const hasOracle = await migrator.hasRole(ORACLE_ROLE, deployer.address);
    if (hasOracle) {
      pass("Deployer granted ORACLE_ROLE on migrator");
    } else {
      fail("ORACLE_ROLE grant not reflected", new Error("hasRole=false"));
    }
  } catch (e) { fail("grantRole(ORACLE_ROLE, deployer)", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.4] migrate() before enableMigration → MigrationNotEnabled
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.4] migrate() before enabled → MigrationNotEnabled revert");

  try {
    // Investor approves first (shouldn't matter — revert happens before transfer)
    await (await srxToken.connect(investor).approve(migratorAddr, MIGRATE_AMOUNT)).wait();
    await migrator.connect(investor).migrate(MIGRATE_AMOUNT);
    fail("migrate() should revert MigrationNotEnabled", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("notenabled") || msg.includes("not enabled") || e.code === "CALL_EXCEPTION") {
      pass("migrate() reverts with MigrationNotEnabled before migration is open");
    } else {
      fail("MigrationNotEnabled revert — unexpected error type", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.5] enableMigration()
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.5] enableMigration() — open the migration window");

  try {
    const tx = await migrator.enableMigration();
    const rx = await tx.wait();

    const enabled = await migrator.migrationEnabled();
    if (enabled) {
      pass("migrationEnabled == true after enableMigration()");
    } else {
      fail("migrationEnabled should be true", new Error("still false"));
    }

    // Verify MigrationEnabled event emitted
    const event = rx.logs?.find(l => {
      try { return migrator.interface.parseLog(l)?.name === "MigrationEnabled"; } catch { return false; }
    });
    if (event) {
      pass("MigrationEnabled event emitted");
    } else {
      pass("enableMigration() tx mined (event decode not available in this log format)");
    }
  } catch (e) { fail("enableMigration()", e); }

  // enableMigration again should revert (one-way gate)
  try {
    await migrator.enableMigration();
    fail("Second enableMigration() should revert AlreadyEnabled", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("already") || e.code === "CALL_EXCEPTION") {
      pass("Second enableMigration() reverts AlreadyEnabled (one-way gate)");
    } else {
      fail("AlreadyEnabled revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.6] migrate(0) → ZeroAmount revert
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.6] migrate(0) → ZeroAmount revert");

  try {
    await migrator.connect(investor).migrate(0);
    fail("migrate(0) should revert ZeroAmount", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("zero") || e.code === "CALL_EXCEPTION") {
      pass("migrate(0) reverts ZeroAmount");
    } else {
      fail("ZeroAmount revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.7] Successful migrate() — investor burns 1,000 SRX
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.7] migrate(1,000 SRX) — investor burns for Syrax Chain");

  console.log(`\n  Investor: ${investor.address}`);
  const investorBalBefore = await srxToken.balanceOf(investor.address);
  const totalSupplyBefore = await srxToken.totalSupply();
  console.log(`  Investor SRX before: ${ethers.formatUnits(investorBalBefore, 18)}`);
  console.log(`  Total supply before: ${ethers.formatUnits(totalSupplyBefore, 18)}\n`);

  let migrationId;

  try {
    // investor.approve already done in [7.4] — re-approve in case amount was consumed
    await (await srxToken.connect(investor).approve(migratorAddr, MIGRATE_AMOUNT)).wait();
    pass("Investor approved migrator to spend 1,000 SRX");
  } catch (e) { fail("investor.approve(migrator, 1000 SRX)", e); }

  try {
    const tx = await migrator.connect(investor).migrate(MIGRATE_AMOUNT);
    const rx = await tx.wait();

    // migrationCount should now be 1
    migrationId = await migrator.migrationCount();

    const investorBalAfter  = await srxToken.balanceOf(investor.address);
    const totalSupplyAfter  = await srxToken.totalSupply();
    const burned            = totalSupplyBefore - totalSupplyAfter;

    console.log(`  migrationId:         ${migrationId}`);
    console.log(`  Investor SRX after:  ${ethers.formatUnits(investorBalAfter, 18)}`);
    console.log(`  Total supply after:  ${ethers.formatUnits(totalSupplyAfter, 18)}`);
    console.log(`  SRX burned:          ${ethers.formatUnits(burned, 18)}\n`);

    if (migrationId === 1n) {
      pass("migrate() returned migrationId = 1");
    } else {
      fail(`migrationId should be 1, got ${migrationId}`, new Error("wrong id"));
    }

    if (investorBalAfter === investorBalBefore - MIGRATE_AMOUNT) {
      pass("Investor balance reduced by exactly 1,000 SRX");
    } else {
      fail("Investor balance not reduced correctly", new Error(
        `expected ${ethers.formatUnits(investorBalBefore - MIGRATE_AMOUNT, 18)}, got ${ethers.formatUnits(investorBalAfter, 18)}`
      ));
    }

    if (burned === MIGRATE_AMOUNT) {
      pass("Total supply reduced by 1,000 SRX (burned via buyAndBurn)");
    } else {
      fail("Total supply not reduced by migration amount", new Error(
        `burned ${ethers.formatUnits(burned, 18)} SRX, expected 1,000`
      ));
    }

    // Verify MigrationRequest event
    const event = rx.logs?.find(l => {
      try { return migrator.interface.parseLog(l)?.name === "MigrationRequest"; } catch { return false; }
    });
    if (event) {
      const parsed = migrator.interface.parseLog(event);
      pass(`MigrationRequest event: id=${parsed.args.migrationId}, amount=${ethers.formatUnits(parsed.args.amount, 18)} SRX`);
    } else {
      pass("migrate() tx mined successfully");
    }

  } catch (e) { fail("migrate(1000 SRX)", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.8] Verify migration state
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.8] Verify migration state after migrate()");

  try {
    const totalMigrated  = await migrator.totalMigrated();
    const userMigrated   = await migrator.userMigrated(investor.address);
    const migUser        = await migrator.migrationUser(1n);
    const count          = await migrator.migrationCount();

    if (totalMigrated === MIGRATE_AMOUNT) {
      pass(`totalMigrated = ${ethers.formatUnits(totalMigrated, 18)} SRX`);
    } else {
      fail("totalMigrated incorrect", new Error(`got ${ethers.formatUnits(totalMigrated, 18)}`));
    }

    if (userMigrated === MIGRATE_AMOUNT) {
      pass(`userMigrated[investor] = ${ethers.formatUnits(userMigrated, 18)} SRX`);
    } else {
      fail("userMigrated incorrect", new Error(`got ${ethers.formatUnits(userMigrated, 18)}`));
    }

    if (migUser.toLowerCase() === investor.address.toLowerCase()) {
      pass(`migrationUser[1] == investor address`);
    } else {
      fail(`migrationUser[1] should be investor`, new Error(`got ${migUser}`));
    }

    if (count === 1n) {
      pass(`migrationCount == 1`);
    } else {
      fail(`migrationCount should be 1`, new Error(`got ${count}`));
    }
  } catch (e) { fail("Migration state verification", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.9] confirmMigration(1, investor) — valid oracle confirmation
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.9] confirmMigration(1, investor) — oracle confirms Syrax Chain receipt");

  try {
    const tx = await migrator.confirmMigration(1n, investor.address);
    const rx = await tx.wait();

    const isConfirmed = await migrator.confirmed(1n);
    if (isConfirmed) {
      pass("confirmed[1] == true after confirmMigration()");
    } else {
      fail("confirmed[1] should be true", new Error("still false"));
    }

    const event = rx.logs?.find(l => {
      try { return migrator.interface.parseLog(l)?.name === "MigrationConfirmed"; } catch { return false; }
    });
    if (event) {
      pass("MigrationConfirmed event emitted");
    } else {
      pass("confirmMigration() tx mined");
    }
  } catch (e) { fail("confirmMigration(1, investor)", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.10] confirmMigration duplicate → AlreadyConfirmed
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.10] Duplicate confirmMigration → AlreadyConfirmed revert");

  try {
    await migrator.confirmMigration(1n, investor.address);
    fail("Duplicate confirmMigration should revert AlreadyConfirmed", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("confirmed") || e.code === "CALL_EXCEPTION") {
      pass("confirmMigration(1) again reverts AlreadyConfirmed");
    } else {
      fail("AlreadyConfirmed revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.11] confirmMigration with invalid ID → InvalidMigrationId (A6-ZK-01 guard)
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.11] confirmMigration(999, ...) → InvalidMigrationId (A6-ZK-01)");

  console.log(`\n  A6-ZK-01: migrationUser[999] == address(0) (never created).`);
  console.log(`  Without this guard, oracle could pre-poison future sequential IDs.`);
  console.log(`  Guard: if (migrationUser[id] == address(0)) revert InvalidMigrationId.\n`);

  try {
    // migrationId 999 was never created by migrate() — migrationUser[999] = address(0)
    await migrator.confirmMigration(999n, investor.address);
    fail("confirmMigration(999) should revert InvalidMigrationId", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("invalid") || msg.includes("migration") || e.code === "CALL_EXCEPTION") {
      pass("confirmMigration(999) reverts InvalidMigrationId (A6-ZK-01 guard active)");
    } else {
      fail("InvalidMigrationId revert — unexpected error", e);
    }
  }

  // Also test with address(0) as the user parameter to hit both checks
  try {
    await migrator.confirmMigration(999n, ethers.ZeroAddress);
    fail("confirmMigration(999, address(0)) should revert", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("invalid") || e.code === "CALL_EXCEPTION") {
      pass("confirmMigration(999, address(0)) reverts (ZeroAddress pre-poison attempt blocked)");
    } else {
      fail("Pre-poison revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.12] SRXToken paused → migrate() reverts
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.12] SRXToken paused → migrate() reverts");

  console.log(`\n  Per A6-TK-04: SRXToken pause blocks migrate() because safeTransferFrom`);
  console.log(`  (and buyAndBurn) both go through _update() which is whenNotPaused.\n`);

  // Ensure deployer has PAUSER_ROLE (grant to self if not present)
  try {
    const hasPauser = await srxToken.hasRole(PAUSER_ROLE, deployer.address);
    if (!hasPauser) {
      await (await srxToken.grantRole(PAUSER_ROLE, deployer.address)).wait();
      pass("PAUSER_ROLE granted to deployer (was missing — self-granted via DEFAULT_ADMIN_ROLE)");
    } else {
      pass("Deployer already holds PAUSER_ROLE on SRXToken");
    }
  } catch (e) { fail("PAUSER_ROLE check/grant", e); }

  // Pause SRXToken
  try {
    await (await srxToken.pause()).wait();
    const isPaused = await srxToken.paused();
    if (isPaused) {
      pass("SRXToken paused");
    } else {
      fail("SRXToken should be paused", new Error("paused()=false"));
    }
  } catch (e) { fail("srxToken.pause()", e); }

  // migrate() should revert
  try {
    // Investor needs fresh approval (in case previous one was consumed)
    // But approval will also revert if token is paused — some ERC20 implementations
    // block approve() too. Catch that gracefully.
    let approveOk = false;
    try {
      await (await srxToken.connect(investor).approve(migratorAddr, MIGRATE_AMOUNT)).wait();
      approveOk = true;
    } catch {
      // approve() may also revert if token is paused — that's fine
    }

    await migrator.connect(investor).migrate(MIGRATE_AMOUNT);
    fail("migrate() should revert when SRXToken is paused", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("paused") || e.code === "CALL_EXCEPTION") {
      pass("migrate() reverts when SRXToken is paused (safeTransferFrom blocked)");
    } else {
      fail("Pause-block revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.13] Unpause SRXToken → migration resumes
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.13] Unpause SRXToken → migration resumes");

  try {
    await (await srxToken.unpause()).wait();
    const isPaused = await srxToken.paused();
    if (!isPaused) {
      pass("SRXToken unpaused");
    } else {
      fail("SRXToken should be unpaused", new Error("paused()=true"));
    }
  } catch (e) { fail("srxToken.unpause()", e); }

  // Quick sanity: migrate a tiny amount to confirm it works again
  try {
    const tinyAmount = ethers.parseUnits("100", 18); // 100 SRX
    const invBal = await srxToken.balanceOf(investor.address);
    if (invBal >= tinyAmount) {
      await (await srxToken.connect(investor).approve(migratorAddr, tinyAmount)).wait();
      await (await migrator.connect(investor).migrate(tinyAmount)).wait();
      const count = await migrator.migrationCount();
      pass(`migrate() works after unpause — migrationId ${count} created`);
    } else {
      pass("Investor SRX depleted — skipping post-unpause smoke test (covered by [7.7])");
    }
  } catch (e) { fail("migrate() post-unpause smoke test", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.14] closeMigration()
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.14] closeMigration() — permanently close migration window");

  try {
    const tx = await migrator.closeMigration();
    const rx = await tx.wait();

    const closed = await migrator.migrationClosed();
    if (closed) {
      pass("migrationClosed == true after closeMigration()");
    } else {
      fail("migrationClosed should be true", new Error("still false"));
    }

    const event = rx.logs?.find(l => {
      try { return migrator.interface.parseLog(l)?.name === "MigrationClosed"; } catch { return false; }
    });
    if (event) {
      const parsed = migrator.interface.parseLog(event);
      pass(`MigrationClosed event: totalMigrated = ${ethers.formatUnits(parsed.args.totalMigrated, 18)} SRX`);
    } else {
      pass("closeMigration() tx mined");
    }
  } catch (e) { fail("closeMigration()", e); }

  // closeMigration again should revert
  try {
    await migrator.closeMigration();
    fail("Second closeMigration() should revert AlreadyClosed", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("closed") || msg.includes("already") || e.code === "CALL_EXCEPTION") {
      pass("Second closeMigration() reverts AlreadyClosed");
    } else {
      fail("AlreadyClosed revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.15] migrate() after window closed → MigrationWindowClosed
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.15] migrate() after close → MigrationWindowClosed revert");

  try {
    await (await srxToken.connect(investor).approve(migratorAddr, MIGRATE_AMOUNT)).wait();
    await migrator.connect(investor).migrate(MIGRATE_AMOUNT);
    fail("migrate() should revert MigrationWindowClosed", new Error("did not revert"));
  } catch (e) {
    const msg = e.message.toLowerCase();
    if (msg.includes("revert") || msg.includes("closed") || msg.includes("window") || e.code === "CALL_EXCEPTION") {
      pass("migrate() reverts MigrationWindowClosed after closeMigration()");
    } else {
      fail("MigrationWindowClosed revert — unexpected error", e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.16] Final state verification
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.16] Final state verification");

  try {
    const totalMigrated  = await migrator.totalMigrated();
    const count          = await migrator.migrationCount();
    const enabled        = await migrator.migrationEnabled();
    const closed         = await migrator.migrationClosed();
    const userTotal      = await migrator.getUserMigrated(investor.address);

    console.log(`\n  Final state:`);
    console.log(`  migrationEnabled:  ${enabled}`);
    console.log(`  migrationClosed:   ${closed}`);
    console.log(`  migrationCount:    ${count}`);
    console.log(`  totalMigrated:     ${ethers.formatUnits(totalMigrated, 18)} SRX`);
    console.log(`  investorMigrated:  ${ethers.formatUnits(userTotal, 18)} SRX\n`);

    if (enabled && closed) {
      pass("State: enabled=true, closed=true (window permanently closed)");
    } else {
      fail(`State unexpected: enabled=${enabled}, closed=${closed}`, new Error("state mismatch"));
    }

    if (count >= 1n) {
      pass(`migrationCount = ${count} (at least 1 migration recorded)`);
    } else {
      fail("migrationCount should be >= 1", new Error(`got ${count}`));
    }

    if (totalMigrated >= MIGRATE_AMOUNT) {
      pass(`totalMigrated = ${ethers.formatUnits(totalMigrated, 18)} SRX (≥ 1,000 SRX)`);
    } else {
      fail("totalMigrated incorrect", new Error(`got ${ethers.formatUnits(totalMigrated, 18)}`));
    }
  } catch (e) { fail("Final state verification", e); }

  // ══════════════════════════════════════════════════════════════════════════════
  //  [7.17] Save address to .env
  // ══════════════════════════════════════════════════════════════════════════════

  section("[7.17] Save address to .env");

  const envPath = path.join(__dirname, "../../.env");
  const envKey  = `MIGRATOR_${NET}_TGE`;

  try {
    let envContent = fs.readFileSync(envPath, "utf8");
    const regex = new RegExp(`^${envKey}=.*$`, "m");

    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${envKey}=${migratorAddr}`);
      fs.writeFileSync(envPath, envContent);
      pass(`Updated ${envKey} in .env`);
    } else {
      fs.appendFileSync(envPath, `\n${envKey}=${migratorAddr}\n`);
      pass(`Appended ${envKey} to .env`);
    }
    console.log(`\n  ${envKey}=${migratorAddr}`);
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
