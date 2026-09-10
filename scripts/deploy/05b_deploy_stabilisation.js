/**
 * Step 5b — Deploy StabilisationFund (UUPS proxy)
 *
 * The Syrax Stabilisation Fund (SSF) replaces the raw "strategic wallet"
 * as the destination for the 1,500,000,000 SRX Strategic Reserve (15% of
 * total supply). It implements the three-tier emergency response architecture
 * described in the Syrax Liquidity Resilience Whitepaper.
 *
 * This script must run AFTER Step 5 (Treasury) so the Timelock address is
 * known, and BEFORE Step 6 (Execute TGE) so that 06_execute_tge.js can
 * use the SSF address as the strategic reserve destination in setAllocations().
 *
 * What this script does:
 *  1. Deploys the StabilisationFund implementation contract.
 *  2. Deploys an ERC1967Proxy wrapping it (UUPS pattern, consistent with
 *     SRXStaking and SRXTreasury).
 *  3. Grants GOVERNANCE_ROLE to the Timelock (sole governance authority
 *     over capital deployment, parameter changes, and stress resolution).
 *  4. PAUSER_ROLE is left with the deployer admin for now.
 *     Step 8 (GuardianModule) will:
 *       a. Grant PAUSER_ROLE on SSF to GuardianModule.
 *       b. Revoke PAUSER_ROLE from the deployer.
 *       c. Register MODULE_SSF inside GuardianModule.
 *
 * Post-deploy role grants (NOT done here — handled by governance or Step 8):
 *  - GUARDIAN_ROLE   → 4-of-7 multi-sig (founders + lead investors + DAO delegates)
 *  - DEPLOYER_ROLE   → Treasurer multi-sig (Gnosis Safe)
 *  - ORACLE_REPORTER_ROLE → Off-chain monitor / Chainlink Automation upkeep
 *
 * Prerequisites (all in .env):
 *  SRX_TOKEN_<NETWORK>   — from Step 1
 *  TIMELOCK_<NETWORK>    — from Step 2
 *
 * Run: npx hardhat run scripts/deploy/05b_deploy_stabilisation.js --network sepolia
 */
const { ethers, upgrades, network } = require("hardhat");
const { WALLETS, SSF }              = require("./00_config");

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

  console.log(`SRX Token:  ${srxToken}`);
  console.log(`Timelock:   ${timelock}`);
  console.log(`Admin:      ${admin}`);
  console.log(`\nSSF parameters:`);
  console.log(`  maxDeployerBps:       ${SSF.MAX_DEPLOYER_BPS} bps (${SSF.MAX_DEPLOYER_BPS / 100}% Tier 1 cap)`);
  console.log(`  maxGuardianBps:       ${SSF.MAX_GUARDIAN_BPS} bps (${SSF.MAX_GUARDIAN_BPS / 100}% Tier 2 combined cap)`);
  console.log(`  withdrawLockDuration: ${SSF.WITHDRAW_LOCK_DURATION}s (${SSF.WITHDRAW_LOCK_DURATION / 86400} days)\n`);

  // ── Deploy StabilisationFund (UUPS proxy) ───────────────────────────────

  console.log("[1/2] Deploying StabilisationFund (UUPS proxy)...");
  const StabilisationFund = await ethers.getContractFactory("StabilisationFund");
  const ssf = await upgrades.deployProxy(
    StabilisationFund,
    [srxToken, admin, SSF.MAX_DEPLOYER_BPS, SSF.MAX_GUARDIAN_BPS, SSF.WITHDRAW_LOCK_DURATION],
    { initializer: "initialize", kind: "uups" }
  );
  await ssf.waitForDeployment();
  const proxyAddr = await ssf.getAddress();
  console.log(`  Proxy: ${proxyAddr}`);

  // ── Grant GOVERNANCE_ROLE to Timelock ────────────────────────────────────

  console.log("\n[2/2] Granting GOVERNANCE_ROLE to Timelock...");
  const GOV_ROLE = await ssf.GOVERNANCE_ROLE();
  await (await ssf.grantRole(GOV_ROLE, timelock)).wait();
  console.log(`  ✓ GOVERNANCE_ROLE → ${timelock}`);

  // Verify deployment state
  console.log("\n─── Verification ───");
  console.log(`  stressActive:          ${await ssf.stressActive()}`);
  console.log(`  maxDeployerBps:        ${await ssf.maxDeployerBps()}`);
  console.log(`  maxGuardianBps:        ${await ssf.maxGuardianBps()}`);
  console.log(`  withdrawLockDuration:  ${await ssf.withdrawLockDuration()}s`);
  console.log(`  GOVERNANCE_ROLE→TL:    ${await ssf.hasRole(GOV_ROLE, timelock)}`);
  console.log(`  PAUSER_ROLE→admin:     ${await ssf.hasRole(await ssf.PAUSER_ROLE(), admin)}`);

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ✅ StabilisationFund deployed and wired`);
  console.log(`${"─".repeat(60)}`);
  console.log(`\n📋 Save to .env:`);
  console.log(`STABILISATION_FUND_${NET}=${proxyAddr}`);

  console.log(`\n📋 Remaining role grants (done via governance or Step 8):`);
  console.log(`  GUARDIAN_ROLE   → 4-of-7 multi-sig`);
  console.log(`  DEPLOYER_ROLE   → treasurer Gnosis Safe`);
  console.log(`  ORACLE_REPORTER_ROLE → Chainlink Automation upkeep or off-chain monitor`);
  console.log(`  PAUSER_ROLE     → GuardianModule (Step 8 wires this)`);

  console.log(`\n📋 Next step:`);
  console.log(`  Set STABILISATION_FUND_${NET}=${proxyAddr} in .env`);
  console.log(`  Then run Step 6 (Execute TGE) — it will use this address`);
  console.log(`  as the strategic reserve destination in setAllocations().`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
