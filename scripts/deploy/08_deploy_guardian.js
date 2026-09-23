/**
 * Step 8 — Deploy GuardianModule and wire it as PAUSER_ROLE on all protocol contracts.
 *
 * GuardianModule is NON-upgradeable by design. An upgradeable guardian could deploy
 * a new implementation with an extended sunset, undermining the immutable MAXIMUM_SUNSET
 * guarantee. Deploy once; the address is permanent.
 *
 * What this script does:
 *  1. Deploys GuardianModule with a configurable sunset duration.
 *  2. Grants PAUSER_ROLE on: SRXToken, SRXStaking, FeeController, SRXTreasury.
 *     (SRXOFTNative on remote chains is wired via 07_deploy_bridge.js — see note below.)
 *  3. Grants CIRCUIT_BREAKER_ROLE to the designated off-chain monitor address.
 *  4. Registers all five modules inside GuardianModule.
 *  5. Revokes the deployer's PAUSER_ROLE on each contract, if it ever held one
 *     (guardian is now sole pauser).
 *
 * ⛔ SC-TRUST-002 (finding DEP-01): every grant/revoke above is gated by a role
 *    whose admin is WALLETS.admin — the admin Gnosis Safe on mainnet, a contract,
 *    never the deployer EOA. All of them now route through scripts/deploy/lib/adminTx.js:
 *    executed immediately if the loaded signer IS WALLETS.admin (testnets), otherwise
 *    encoded and queued as a Gnosis Safe Transaction Builder batch. Step 4 used to
 *    grant GuardianModule's GOVERNANCE_ROLE to the DEPLOYER so it could call
 *    registerModule(), then revoke it — exactly the "deployer holds a role, even
 *    temporarily" pattern SC-TRUST-002 forbids. It now grants that GOVERNANCE_ROLE
 *    to WALLETS.admin instead, for the same one-batch lifetime (grant → register ×6
 *    → revoke, atomic in a single Safe transaction when queued).
 *
 * Bridge module note:
 *  The "bridge" in GuardianModule terms is SRXToken itself (OFT send() is on the token).
 *  MODULE_BRIDGE's target is SRXToken — pausing the token blocks bridge sends.
 *  For remote chains, after running 07_deploy_bridge.js, repeat steps 2–5 on each
 *  remote chain's SRXOFTNative using the guardian address on that chain.
 *
 * Prerequisites (all in .env):
 *  SRX_TOKEN_<NETWORK>          — from Step 1
 *  TIMELOCK_<NETWORK>           — from Step 2
 *  STAKING_<NETWORK>            — from Step 4
 *  FEE_CONTROLLER_<NETWORK>     — from Step 4
 *  TREASURY_<NETWORK>           — from Step 5
 *  STABILISATION_FUND_<NETWORK> — from Step 5b  ← NEW
 *  GUARDIAN_MULTISIG            — Gnosis Safe holding GUARDIAN_ROLE
 *  CIRCUIT_BREAKER_ADDRESS      — Off-chain monitor wallet or contract
 *  GUARDIAN_SUNSET_DAYS         — (optional) defaults to 180 days
 *
 * Run: npx hardhat run scripts/deploy/08_deploy_guardian.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const readline             = require("readline");
const { WALLETS }          = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");

// ── Helpers ────────────────────────────────────────────────────────────────────

function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET        = network.name.toUpperCase();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Deploying GuardianModule on ${network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"─".repeat(60)}\n`);

  // ── Load addresses from .env ─────────────────────────────────────────────

  const srxTokenAddr       = env(`SRX_TOKEN_${NET}`);
  const timelockAddr       = env(`TIMELOCK_${NET}`);
  const stakingAddr        = env(`STAKING_${NET}`);
  const feeControllerAddr  = env(`FEE_CONTROLLER_${NET}`);
  const treasuryAddr       = env(`TREASURY_${NET}`);
  const ssfAddr            = env(`STABILISATION_FUND_${NET}`);
  const guardianMultisig   = process.env.GUARDIAN_MULTISIG   || WALLETS.admin;
  const circuitBreakerAddr = process.env.CIRCUIT_BREAKER_ADDRESS || WALLETS.admin;

  const sunsetDays    = parseInt(process.env.GUARDIAN_SUNSET_DAYS || "180", 10);
  const sunsetSeconds = sunsetDays * 86400;

  console.log("Addresses:");
  console.log(`  SRXToken:             ${srxTokenAddr}`);
  console.log(`  Timelock:             ${timelockAddr}`);
  console.log(`  SRXStaking:           ${stakingAddr}`);
  console.log(`  FeeController:        ${feeControllerAddr}`);
  console.log(`  SRXTreasury:          ${treasuryAddr}`);
  console.log(`  StabilisationFund:    ${ssfAddr}`);
  console.log(`  Guardian multisig:    ${guardianMultisig}`);
  console.log(`  Circuit breaker:      ${circuitBreakerAddr}`);
  console.log(`  Sunset duration:      ${sunsetDays} days (${sunsetSeconds} seconds)\n`);

  const answer = await confirm(
    "⚠️  GuardianModule is NOT upgradeable. MAXIMUM_SUNSET is immutable once deployed.\n" +
    "   Confirm these parameters are correct before proceeding. [yes/no]: "
  );
  if (answer !== "yes") {
    console.log("Deployment cancelled.");
    process.exit(0);
  }

  // ── 1. Deploy GuardianModule ─────────────────────────────────────────────

  console.log("\n[1/5] Deploying GuardianModule...");
  const GuardianModule = await ethers.getContractFactory("GuardianModule");
  const guardian = await GuardianModule.deploy(
    WALLETS.admin,       // DEFAULT_ADMIN_ROLE — Gnosis Safe
    guardianMultisig,    // GUARDIAN_ROLE
    timelockAddr,        // GOVERNANCE_ROLE — SRXTimelock
    sunsetSeconds
  );
  await guardian.waitForDeployment();
  const guardianAddr = await guardian.getAddress();
  console.log(`  GuardianModule: ${guardianAddr}`);
  console.log(`  MAXIMUM_SUNSET: ${await guardian.MAXIMUM_SUNSET()} (${new Date(Number(await guardian.MAXIMUM_SUNSET()) * 1000).toISOString()})`);

  // Every admin-only call below is gated by DEFAULT_ADMIN_ROLE (or, for
  // registerModule, GOVERNANCE_ROLE) on the target contract, and the holder is
  // WALLETS.admin — the admin Safe on mainnet, never the deployer (SC-TRUST-002).
  const batch = createAdminBatch("08_guardian");

  // ── 2. Grant PAUSER_ROLE on all protocol contracts ───────────────────────

  console.log("\n[2/5] Granting PAUSER_ROLE to GuardianModule on all contracts...");

  const srxToken = await ethers.getContractAt("SRXToken", srxTokenAddr);
  const staking  = await ethers.getContractAt("SRXStaking", stakingAddr);
  const fee      = await ethers.getContractAt("FeeController", feeControllerAddr);
  const treasury = await ethers.getContractAt("SRXTreasury", treasuryAddr);
  const ssf      = await ethers.getContractAt("StabilisationFund", ssfAddr);

  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

  await batch.send(srxToken, "grantRole", [PAUSER_ROLE, guardianAddr], "SRXToken.PAUSER_ROLE → GuardianModule");
  await batch.send(staking,  "grantRole", [PAUSER_ROLE, guardianAddr], "SRXStaking.PAUSER_ROLE → GuardianModule");
  await batch.send(fee,      "grantRole", [PAUSER_ROLE, guardianAddr], "FeeController.PAUSER_ROLE → GuardianModule");
  await batch.send(treasury, "grantRole", [PAUSER_ROLE, guardianAddr], "SRXTreasury.PAUSER_ROLE → GuardianModule");
  await batch.send(ssf,      "grantRole", [PAUSER_ROLE, guardianAddr], "StabilisationFund.PAUSER_ROLE → GuardianModule");

  // ── 3. Grant CIRCUIT_BREAKER_ROLE ────────────────────────────────────────

  console.log("\n[3/5] Granting CIRCUIT_BREAKER_ROLE...");
  const CB_ROLE = await guardian.CIRCUIT_BREAKER_ROLE();
  await batch.send(guardian, "grantRole", [CB_ROLE, circuitBreakerAddr], `GuardianModule.CIRCUIT_BREAKER_ROLE → ${circuitBreakerAddr}`);

  // ── 4. Register all five modules ────────────────────────────────────────
  //
  // registerModule() requires GOVERNANCE_ROLE, held by the Timelock (constructor)
  // — not by the admin Safe and never by the deployer. The admin Safe DOES hold
  // DEFAULT_ADMIN_ROLE on GuardianModule, which is the admin role for
  // GOVERNANCE_ROLE (no _setRoleAdmin override), so it can grant that role to
  // itself, register the six modules, then revoke it — all three groups queued
  // into the SAME Safe batch, in this order, so they execute atomically: the
  // Safe is never left holding GOVERNANCE_ROLE. SC-TRUST-002: this used to grant
  // GOVERNANCE_ROLE to the DEPLOYER for the same purpose, which is exactly the
  // "deployer holds a role, even temporarily" pattern that finding forbade.

  console.log("\n[4/5] Registering modules inside GuardianModule...");

  const GOV_ROLE = await guardian.GOVERNANCE_ROLE();
  const adminHasGov = await guardian.hasRole(GOV_ROLE, WALLETS.admin);

  if (!adminHasGov) {
    await batch.send(guardian, "grantRole", [GOV_ROLE, WALLETS.admin], "GuardianModule.GOVERNANCE_ROLE → admin Safe (temporary, for module registration)");
  }

  const MODULE_TOKEN    = await guardian.MODULE_TOKEN();
  const MODULE_BRIDGE   = await guardian.MODULE_BRIDGE();
  const MODULE_STAKING  = await guardian.MODULE_STAKING();
  const MODULE_FEE      = await guardian.MODULE_FEE();
  const MODULE_TREASURY = await guardian.MODULE_TREASURY();
  // SSF module ID — computed the same way as the constants in GuardianModule
  const MODULE_SSF      = ethers.keccak256(ethers.toUtf8Bytes("STABILISATION_FUND"));

  // MODULE_TOKEN and MODULE_BRIDGE both target SRXToken:
  //   - TOKEN pauses ERC-20 transfers
  //   - BRIDGE is semantically "bridge sends" — pausing the token blocks OFT send()
  //   Both use srxTokenAddr as the pausable target.
  await batch.send(guardian, "registerModule", [MODULE_TOKEN,    srxTokenAddr],     "MODULE_TOKEN    → SRXToken");
  await batch.send(guardian, "registerModule", [MODULE_BRIDGE,   srxTokenAddr],     "MODULE_BRIDGE   → SRXToken (pausing token blocks OFT sends)");
  await batch.send(guardian, "registerModule", [MODULE_STAKING,  stakingAddr],      "MODULE_STAKING  → SRXStaking");
  await batch.send(guardian, "registerModule", [MODULE_FEE,      feeControllerAddr],"MODULE_FEE      → FeeController");
  await batch.send(guardian, "registerModule", [MODULE_TREASURY, treasuryAddr],     "MODULE_TREASURY → SRXTreasury");
  await batch.send(guardian, "registerModule", [MODULE_SSF,      ssfAddr],          "MODULE_SSF      → StabilisationFund");

  // Revoke the temporary GOVERNANCE_ROLE from the admin Safe, last in the batch.
  if (!adminHasGov) {
    await batch.send(guardian, "revokeRole", [GOV_ROLE, WALLETS.admin], "GuardianModule.GOVERNANCE_ROLE revoked from admin Safe (restores delay-only state)");
  }

  // ── 5. Revoke deployer's PAUSER_ROLE, if it ever held one ────────────────
  //
  // On a real deployment the deployer is never granted PAUSER_ROLE by this
  // script (grants above all target guardianAddr), so these checks are
  // defensive rather than undoing anything done above — kept for the same
  // reason the original script kept them: a deployer that happens to equal
  // WALLETS.admin (testnets) or picked up the role some other way.

  console.log("\n[5/5] Revoking deployer PAUSER_ROLE on all contracts...");

  if ((await srxToken.hasRole(PAUSER_ROLE, deployer.address))) {
    await batch.send(srxToken, "revokeRole", [PAUSER_ROLE, deployer.address], "SRXToken.PAUSER_ROLE revoked from deployer");
  }

  if ((await staking.hasRole(PAUSER_ROLE, deployer.address))) {
    await batch.send(staking, "revokeRole", [PAUSER_ROLE, deployer.address], "SRXStaking.PAUSER_ROLE revoked from deployer");
  }

  if ((await fee.hasRole(PAUSER_ROLE, deployer.address))) {
    await batch.send(fee, "revokeRole", [PAUSER_ROLE, deployer.address], "FeeController.PAUSER_ROLE revoked from deployer");
  }

  if ((await treasury.hasRole(PAUSER_ROLE, deployer.address))) {
    await batch.send(treasury, "revokeRole", [PAUSER_ROLE, deployer.address], "SRXTreasury.PAUSER_ROLE revoked from deployer");
  }

  if ((await ssf.hasRole(PAUSER_ROLE, deployer.address))) {
    await batch.send(ssf, "revokeRole", [PAUSER_ROLE, deployer.address], "StabilisationFund.PAUSER_ROLE revoked from deployer");
  }

  const wrote = await batch.flush();
  if (wrote) {
    console.log(`\n⏳ Every grant/revoke above is queued for the admin Safe (${wrote}).`);
    console.log(`   Nothing is wired until the Safe executes it.`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log("  ✅ GuardianModule fully deployed and wired");
  console.log(`${"─".repeat(60)}`);

  console.log(`\n📋 Save to .env:`);
  console.log(`GUARDIAN_${NET}=${guardianAddr}`);

  console.log(`\n📋 Post-deployment checklist:`);
  console.log(`  [ ] Verify GuardianModule on explorer`);
  console.log(`  [ ] Confirm MAXIMUM_SUNSET in block explorer storage`);
  console.log(`  [ ] Test pause/unpause on Sepolia before mainnet`);
  console.log(`  [ ] Configure circuit breaker via governance proposal:`);
  console.log(`        guardian.configureCircuitBreaker(MODULE_BRIDGE, threshold, windowDuration)`);
  console.log(`  [ ] For remote chains (BSC, zkSync): grant GuardianModule PAUSER_ROLE`);
  console.log(`      on each SRXOFTNative deployment after running 07_deploy_bridge.js`);
  console.log(`  [ ] If a safe_batch file was written above, the admin Safe executes it before step 9`);
  console.log(`      (GuardianModule's DEFAULT_ADMIN_ROLE was granted to the Safe in the constructor;`);
  console.log(`       the deployer never holds it)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
