/**
 * Step 5b — Deploy StabilisationFund (a plain contract: not upgradeable, no proxy; REG-53)
 *
 * The Syrax Stabilisation Fund (SSF) replaces the raw "strategic wallet"
 * as the destination for the 1,500,000,000 SRX Strategic Reserve (15% of
 * total supply). It implements a three-tier emergency response architecture
 * (see the contract). REG-50: depositor rewards are capped for good at
 * SSF.REWARD_ALLOCATION, fixed here at deployment; mainnet refuses to run until set.
 *
 * This script must run AFTER Step 5 (Treasury) so the Timelock address is
 * known, and BEFORE Step 6 (Execute TGE) so that 06_execute_tge.js can
 * use the SSF address as the strategic reserve destination in setAllocations().
 *
 * What this script does:
 *  1. Deploys the StabilisationFund once, with its constructor (no proxy, no
 *     initializer: its code can never change; verify_roles.js fails it if it is a proxy).
 *     The constructor fixes TGE_DISTRIBUTOR_<NETWORK> (Step 3) for good (REG-50, E-01): if
 *     Step 3 is ever re-run, this step must be re-run against the new distributor.
 *  2. Grants GOVERNANCE_ROLE to the Timelock (sole governance authority
 *     over capital deployment, parameter changes, and stress resolution).
 *  3. PAUSER_ROLE stays with the admin Safe (the deployer never holds a role) for now.
 *     Step 8 (GuardianModule) will:
 *       a. Grant PAUSER_ROLE on SSF to GuardianModule.
 *       b. Register MODULE_SSF inside GuardianModule.
 *
 * Post-deploy role grants (NOT done here — handled by governance or Step 8):
 *  - GUARDIAN_ROLE   → 4-of-7 multi-sig (founders + lead investors + DAO delegates);
 *                      verify_roles.js knows it as SSF_GUARDIAN_MULTISIG (not GuardianModule's PAUSE_GUARDIAN)
 *  - DEPLOYER_ROLE   → Treasurer multi-sig (Gnosis Safe)
 *  - ORACLE_REPORTER_ROLE → Off-chain monitor / Chainlink Automation upkeep
 *
 * Prerequisites (all in .env):
 *  SRX_TOKEN_<NETWORK>   — from Step 1
 *  TIMELOCK_<NETWORK>    — from Step 2
 *
 * Run: npx hardhat run scripts/deploy/05b_deploy_stabilisation.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS, SSF, ssfRewardAllocation } = require("./00_config");
const { createAdminBatch }          = require("./lib/adminTx");

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET        = network.name.toUpperCase();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Deploying StabilisationFund on ${network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"─".repeat(60)}\n`);

  // ── Load prerequisites ───────────────────────────────────────────────────

  const srxToken = process.env[`SRX_TOKEN_${NET}`];
  const timelock = process.env[`TIMELOCK_${NET}`];
  const admin    = WALLETS.admin;

  if (!srxToken) throw new Error(`SRX_TOKEN_${NET} not set in .env`);
  if (!timelock) throw new Error(`TIMELOCK_${NET} not set in .env — run Step 2 first`);
  // REG-50: rewards can only be backed by what the launch distributor (step 03) records
  // delivering here, so its address is fixed into the contract now.
  const tgeDistributor = process.env[`TGE_DISTRIBUTOR_${network.name.toUpperCase()}`];
  if (!tgeDistributor) throw new Error(`TGE_DISTRIBUTOR_${network.name.toUpperCase()} not set in .env — run Step 3 first (05b)`);

  console.log(`SRX Token:  ${srxToken}`);
  console.log(`Timelock:   ${timelock}`);
  console.log(`Admin:      ${admin}`);
  console.log(`\nSSF parameters:`);
  console.log(`  maxDeployerBps:       ${SSF.MAX_DEPLOYER_BPS} bps (${SSF.MAX_DEPLOYER_BPS / 100}% Tier 1 cap)`);
  console.log(`  maxGuardianBps:       ${SSF.MAX_GUARDIAN_BPS} bps (${SSF.MAX_GUARDIAN_BPS / 100}% Tier 2 combined cap)`);
  console.log(`  withdrawLockDuration: ${SSF.WITHDRAW_LOCK_DURATION}s (${SSF.WITHDRAW_LOCK_DURATION / 86400} days)`);
  const rewardAllocation = ssfRewardAllocation(network.name); // throws on mainnet until decided
  console.log(`  rewardAllocation:     ${ethers.formatUnits(rewardAllocation, 18)} SRX (fixed for good, REG-50)\n`);

  // ── Deploy StabilisationFund ───────────────────────────────

  console.log("[1/2] Deploying StabilisationFund...");
  const StabilisationFund = await ethers.getContractFactory("StabilisationFund");
  const ssf = await StabilisationFund.deploy(...[srxToken, admin, SSF.MAX_DEPLOYER_BPS, SSF.MAX_GUARDIAN_BPS, SSF.WITHDRAW_LOCK_DURATION, rewardAllocation, tgeDistributor]);
  await ssf.waitForDeployment();
  const fundAddr = await ssf.getAddress();
  console.log(`  StabilisationFund: ${fundAddr}`);

  // ── Grant GOVERNANCE_ROLE to Timelock ────────────────────────────────────

  console.log("\n[2/2] Granting GOVERNANCE_ROLE to Timelock...");
  const GOV_ROLE = await ssf.GOVERNANCE_ROLE();

  // grantRole on StabilisationFund is DEFAULT_ADMIN_ROLE-gated, held by
  // WALLETS.admin (the admin Safe on mainnet) — not the deployer. SC-TRUST-002:
  // route through it.
  const batch = createAdminBatch("05b_stabilisation");
  const { executed } = await batch.send(ssf, "grantRole", [GOV_ROLE, timelock], "StabilisationFund.grantRole(GOVERNANCE_ROLE, Timelock)");
  const wrote = await batch.flush();

  // Verify deployment state
  console.log("\n─── Verification ───");
  console.log(`  stressActive:          ${await ssf.stressActive()}`);
  console.log(`  maxDeployerBps:        ${await ssf.maxDeployerBps()}`);
  console.log(`  maxGuardianBps:        ${await ssf.maxGuardianBps()}`);
  console.log(`  withdrawLockDuration:  ${await ssf.withdrawLockDuration()}s`);
  console.log(`  GOVERNANCE_ROLE→TL:    ${await ssf.hasRole(GOV_ROLE, timelock)}${executed ? "" : "  (pending — queued for the admin Safe, see " + wrote + ")"}`);
  console.log(`  PAUSER_ROLE→admin:     ${await ssf.hasRole(await ssf.PAUSER_ROLE(), admin)}`);

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ✅ StabilisationFund deployed and wired`);
  console.log(`${"─".repeat(60)}`);
  console.log(`\n📋 Save to .env:`);
  console.log(`STABILISATION_FUND_${NET}=${fundAddr}`);

  console.log(`\n📋 Remaining role grants (done via governance or Step 8):`);
  console.log(`  GUARDIAN_ROLE   → 4-of-7 multi-sig`);
  console.log(`  DEPLOYER_ROLE   → treasurer Gnosis Safe`);
  console.log(`  ORACLE_REPORTER_ROLE → Chainlink Automation upkeep or off-chain monitor`);
  console.log(`  PAUSER_ROLE     → GuardianModule (Step 8 wires this)`);

  console.log(`\n📋 Next step:`);
  console.log(`  Set STABILISATION_FUND_${NET}=${fundAddr} in .env`);
  console.log(`  Then run Step 6 (Execute TGE) — it will use this address`);
  console.log(`  as the strategic reserve destination in setAllocations().`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
