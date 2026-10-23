/**
 * Step 4 — Deploy SRXStaking + FeeController
 *
 * Both are PLAIN contracts: not upgradeable, no proxy and no initializer (REG-53). Each is
 * deployed once and its constructor sets everything; its code can never change. verify_roles.js
 * fails a deployment where either is an EIP-1967 proxy or answers proxiableUUID().
 *
 * ⛔ SRXStaking fixes TGE_DISTRIBUTOR_<NETWORK> (Step 3) immutably (REG-50, E-01). If Step 3 is
 * ever re-run, this step must be re-run against the new distributor, or 06 refuses to launch.
 *
 * Prerequisites: SRXToken deployed (Step 1).
 *
 * Run: npx hardhat run scripts/deploy/04_deploy_staking.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS } = require("./00_config");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying Staking + FeeController on ${network.name}`);

  const srxToken = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  const admin    = WALLETS.admin;

  if (!srxToken) throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);
  // REG-50: rewards can only be backed by what the launch distributor (step 03) records
  // delivering here, so its address is fixed into the contract now.
  const tgeDistributor = process.env[`TGE_DISTRIBUTOR_${network.name.toUpperCase()}`];
  if (!tgeDistributor) throw new Error(`TGE_DISTRIBUTOR_${network.name.toUpperCase()} not set in .env — run Step 3 first (04)`);

  // ── Deploy SRXStaking ────────────────────────────────────────────────────────

  console.log("\nDeploying SRXStaking...");
  const SRXStaking = await ethers.getContractFactory("SRXStaking");
  const staking = await SRXStaking.deploy(...[srxToken, admin, tgeDistributor]);
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log(`SRXStaking: ${stakingAddress}`);

  // ── Deploy FeeController ─────────────────────────────────────────────────────

  console.log("\nDeploying FeeController...");
  const FeeController = await ethers.getContractFactory("FeeController");
  const fee = await FeeController.deploy(...[stakingAddress, admin]);
  await fee.waitForDeployment();
  const feeAddress = await fee.getAddress();
  console.log(`FeeController: ${feeAddress}`);

  console.log(`\n✅ Staking + FeeController deployed`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`STAKING_${network.name.toUpperCase()}=${stakingAddress}`);
  console.log(`FEE_CONTROLLER_${network.name.toUpperCase()}=${feeAddress}`);
  console.log(`\n⚠️  After deployment, grant GATEWAY_ROLE on FeeController to the Syrax backend address`);
  console.log(`⚠️  Update TGEDistributor staking destination if not yet set (Step 3)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
