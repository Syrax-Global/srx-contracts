/**
 * Step 2 — Deploy Governance (SRXTimelock + SRXGovernor)
 *
 * Deploys the governance stack. The governor is wired to the timelock.
 * The timelock is wired to the governor (proposer) and allows open execution.
 *
 * The admin (Gnosis Safe) holds CANCELLER_ROLE on the timelock as guardian
 * during the 6-month transition period.
 *
 * Prerequisites: SRXToken deployed (Step 1).
 *
 * Run: npx hardhat run scripts/deploy/02_deploy_governance.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS, GOVERNANCE } = require("./00_config");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying Governance on ${network.name}`);

  const srxTokenAddress = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  if (!srxTokenAddress) {
    throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);
  }

  const admin = WALLETS.admin;

  // ── Deploy Timelock ──────────────────────────────────────────────────────────
  console.log("\nDeploying SRXTimelock...");
  const SRXTimelock = await ethers.getContractFactory("SRXTimelock");

  // Proposers and executors are set after governor is deployed.
  // We deploy with empty arrays and wire them post-deployment.
  const timelock = await SRXTimelock.deploy(
    // Derived from the network: 48h on anything not explicitly a testnet, and a
    // hard error rather than a silent short delay. See 00_config.js.
    GOVERNANCE.timelockDelayFor(network.name),
    [],          // proposers — add governor after deploy
    [ethers.ZeroAddress],  // executors — open execution
    admin        // admin (guardian, Gnosis Safe)
  );
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log(`SRXTimelock deployed: ${timelockAddress}`);

  // ── Deploy Governor ──────────────────────────────────────────────────────────
  console.log("\nDeploying SRXGovernor...");
  const SRXGovernor = await ethers.getContractFactory("SRXGovernor");
  const governor = await SRXGovernor.deploy(srxTokenAddress, timelockAddress);
  await governor.waitForDeployment();
  const governorAddress = await governor.getAddress();
  console.log(`SRXGovernor deployed: ${governorAddress}`);

  // ── Wire governor as proposer on timelock ────────────────────────────────────
  console.log("\nGranting PROPOSER_ROLE to governor on timelock...");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();

  await (await timelock.grantRole(PROPOSER_ROLE, governorAddress)).wait();
  console.log(`PROPOSER_ROLE granted to governor`);

  // Admin holds CANCELLER_ROLE as guardian during transition
  await (await timelock.grantRole(CANCELLER_ROLE, admin)).wait();
  console.log(`CANCELLER_ROLE granted to admin (guardian)`);

  console.log(`\n✅ Governance deployed`);
  console.log(`SRXTimelock:  ${timelockAddress}`);
  console.log(`SRXGovernor:  ${governorAddress}`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`TIMELOCK_${network.name.toUpperCase()}=${timelockAddress}`);
  console.log(`GOVERNOR_${network.name.toUpperCase()}=${governorAddress}`);
  console.log(`\n⚠️  After 6 months post-TGE: transfer CANCELLER_ROLE to security council`);
  console.log(`⚠️  At DAO milestone: admin renounces DEFAULT_ADMIN_ROLE on timelock`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
