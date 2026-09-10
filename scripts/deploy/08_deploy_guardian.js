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
 *  5. Revokes the deployer's PAUSER_ROLE on each contract (guardian is now sole pauser).
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

  // ── 2. Grant PAUSER_ROLE on all protocol contracts ───────────────────────

  console.log("\n[2/5] Granting PAUSER_ROLE to GuardianModule on all contracts...");

  const srxToken = await ethers.getContractAt("SRXToken", srxTokenAddr);
  const staking  = await ethers.getContractAt("SRXStaking", stakingAddr);
  const fee      = await ethers.getContractAt("FeeController", feeControllerAddr);
  const treasury = await ethers.getContractAt("SRXTreasury", treasuryAddr);
  const ssf      = await ethers.getContractAt("StabilisationFund", ssfAddr);

  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

  await (await srxToken.grantRole(PAUSER_ROLE, guardianAddr)).wait();
  console.log("  ✓ SRXToken.PAUSER_ROLE → GuardianModule");

  await (await staking.grantRole(PAUSER_ROLE, guardianAddr)).wait();
  console.log("  ✓ SRXStaking.PAUSER_ROLE → GuardianModule");

  await (await fee.grantRole(PAUSER_ROLE, guardianAddr)).wait();
  console.log("  ✓ FeeController.PAUSER_ROLE → GuardianModule");

  await (await treasury.grantRole(PAUSER_ROLE, guardianAddr)).wait();
  console.log("  ✓ SRXTreasury.PAUSER_ROLE → GuardianModule");

  await (await ssf.grantRole(PAUSER_ROLE, guardianAddr)).wait();
  console.log("  ✓ StabilisationFund.PAUSER_ROLE → GuardianModule");

  // ── 3. Grant CIRCUIT_BREAKER_ROLE ────────────────────────────────────────

  console.log("\n[3/5] Granting CIRCUIT_BREAKER_ROLE...");
  const CB_ROLE = await guardian.CIRCUIT_BREAKER_ROLE();
  await (await guardian.grantRole(CB_ROLE, circuitBreakerAddr)).wait();
  console.log(`  ✓ CIRCUIT_BREAKER_ROLE → ${circuitBreakerAddr}`);

  // ── 4. Register all five modules ────────────────────────────────────────
  //
  // registerModule() requires GOVERNANCE_ROLE. The deployer only has
  // DEFAULT_ADMIN_ROLE on GuardianModule. Use it to grant GOVERNANCE_ROLE
  // to the deployer temporarily for setup, then revoke it.

  console.log("\n[4/5] Registering modules inside GuardianModule...");

  const GOV_ROLE = await guardian.GOVERNANCE_ROLE();
  const deployerHasGov = await guardian.hasRole(GOV_ROLE, deployer.address);

  if (!deployerHasGov) {
    await (await guardian.grantRole(GOV_ROLE, deployer.address)).wait();
    console.log("  (Granted GOVERNANCE_ROLE to deployer for setup)");
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
  await (await guardian.registerModule(MODULE_TOKEN,    srxTokenAddr)).wait();
  console.log("  ✓ MODULE_TOKEN    → SRXToken");

  await (await guardian.registerModule(MODULE_BRIDGE,   srxTokenAddr)).wait();
  console.log("  ✓ MODULE_BRIDGE   → SRXToken (pausing token blocks OFT sends)");

  await (await guardian.registerModule(MODULE_STAKING,  stakingAddr)).wait();
  console.log("  ✓ MODULE_STAKING  → SRXStaking");

  await (await guardian.registerModule(MODULE_FEE,      feeControllerAddr)).wait();
  console.log("  ✓ MODULE_FEE      → FeeController");

  await (await guardian.registerModule(MODULE_TREASURY, treasuryAddr)).wait();
  console.log("  ✓ MODULE_TREASURY → SRXTreasury");

  await (await guardian.registerModule(MODULE_SSF,      ssfAddr)).wait();
  console.log("  ✓ MODULE_SSF      → StabilisationFund");

  // Revoke the temporary GOVERNANCE_ROLE from deployer
  if (!deployerHasGov) {
    await (await guardian.revokeRole(GOV_ROLE, deployer.address)).wait();
    console.log("  (Revoked temporary GOVERNANCE_ROLE from deployer)");
  }

  // ── 5. Revoke deployer's PAUSER_ROLE ────────────────────────────────────

  console.log("\n[5/5] Revoking deployer PAUSER_ROLE on all contracts...");

  if ((await srxToken.hasRole(PAUSER_ROLE, deployer.address))) {
    await (await srxToken.revokeRole(PAUSER_ROLE, deployer.address)).wait();
    console.log("  ✓ Revoked from SRXToken");
  }

  if ((await staking.hasRole(PAUSER_ROLE, deployer.address))) {
    await (await staking.revokeRole(PAUSER_ROLE, deployer.address)).wait();
    console.log("  ✓ Revoked from SRXStaking");
  }

  if ((await fee.hasRole(PAUSER_ROLE, deployer.address))) {
    await (await fee.revokeRole(PAUSER_ROLE, deployer.address)).wait();
    console.log("  ✓ Revoked from FeeController");
  }

  if ((await treasury.hasRole(PAUSER_ROLE, deployer.address))) {
    await (await treasury.revokeRole(PAUSER_ROLE, deployer.address)).wait();
    console.log("  ✓ Revoked from SRXTreasury");
  }

  if ((await ssf.hasRole(PAUSER_ROLE, deployer.address))) {
    await (await ssf.revokeRole(PAUSER_ROLE, deployer.address)).wait();
    console.log("  ✓ Revoked from StabilisationFund");
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
  console.log(`  [ ] Transfer DEFAULT_ADMIN_ROLE on GuardianModule to Gnosis Safe`);
  console.log(`      if deployer ≠ WALLETS.admin:`);
  console.log(`        guardian.grantRole(DEFAULT_ADMIN_ROLE, gnosisSafe)`);
  console.log(`        guardian.renounceRole(DEFAULT_ADMIN_ROLE, deployer)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
