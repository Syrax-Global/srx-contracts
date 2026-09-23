/**
 * Step 2 — Deploy Governance (SRXTimelock + SRXGovernor)
 *
 * Deploys the governance stack. The governor is wired to the timelock.
 * The timelock is wired to the governor (proposer) and allows open execution.
 *
 * The governor is named as proposer IN THE TIMELOCK CONSTRUCTOR, using its
 * predicted address, so it receives PROPOSER_ROLE and CANCELLER_ROLE at birth.
 * ⛔ This previously deployed the timelock with no proposers and then called
 *    timelock.grantRole() from the deployer — but the timelock's admin is the
 *    Safe, not the deployer, so both calls revert on any real deployment. And
 *    making the deployer an admin, even briefly, would break SC-TRUST-002.
 *
 * The admin Safe's CANCELLER_ROLE (a veto on hostile proposals — it can stop an
 * operation, never start one) is granted by the Safe itself in
 * scripts/ops/migrate_roles.js phase 1.
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

  // The governor is deployed immediately after the timelock, from the same
  // account, so its address is the deployer's next-but-one CREATE address.
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const predictedGovernor = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });

  const timelock = await SRXTimelock.deploy(
    // Derived from the network: 48h on anything not explicitly a testnet, and a
    // hard error rather than a silent short delay. See 00_config.js.
    GOVERNANCE.timelockDelayFor(network.name),
    [predictedGovernor],   // proposers — the governor (also made canceller)
    [ethers.ZeroAddress],  // executors — open execution
    admin                  // admin (Gnosis Safe) — removed by migrate_roles phase 2
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

  // ── Confirm the governor landed where the timelock expects it ───────────────
  if (governorAddress !== predictedGovernor) {
    throw new Error(`Governor deployed at ${governorAddress}, but the timelock names ${predictedGovernor} ` +
      "as proposer. Another transaction from the deployer intervened. Redeploy both; do not wire this pair.");
  }
  if (!(await timelock.hasRole(await timelock.PROPOSER_ROLE(), governorAddress))) {
    throw new Error("Governor is not a proposer on the timelock");
  }
  console.log(`Governor is proposer and canceller on the timelock`);

  console.log(`\n✅ Governance deployed`);
  console.log(`SRXTimelock:  ${timelockAddress}`);
  console.log(`SRXGovernor:  ${governorAddress}`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`TIMELOCK_${network.name.toUpperCase()}=${timelockAddress}`);
  console.log(`GOVERNOR_${network.name.toUpperCase()}=${governorAddress}`);
  console.log(`\n⚠️  Before launch, scripts/ops/migrate_roles.js moves every admin power behind this`);
  console.log(`   timelock (the Safe keeps only its veto). verify_roles.js blocks mainnet otherwise.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
