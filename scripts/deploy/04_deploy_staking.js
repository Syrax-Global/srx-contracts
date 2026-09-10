/**
 * Step 4 — Deploy SRXStaking + FeeController (UUPS proxies)
 *
 * Both contracts are UUPS upgradeable. This script deploys their
 * implementation contracts and ERC1967 proxy wrappers, then initializes them.
 *
 * Prerequisites: SRXToken deployed (Step 1).
 *
 * Run: npx hardhat run scripts/deploy/04_deploy_staking.js --network sepolia
 */
const { ethers, upgrades, network } = require("hardhat");
const { WALLETS } = require("./00_config");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying Staking + FeeController on ${network.name}`);

  const srxToken = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  const admin    = WALLETS.admin;

  if (!srxToken) throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);

  // ── Deploy SRXStaking ────────────────────────────────────────────────────────

  console.log("\nDeploying SRXStaking (UUPS proxy)...");
  const SRXStaking = await ethers.getContractFactory("SRXStaking");
  const stakingProxy = await upgrades.deployProxy(
    SRXStaking,
    [srxToken, admin],
    { initializer: "initialize", kind: "uups" }
  );
  await stakingProxy.waitForDeployment();
  const stakingAddress = await stakingProxy.getAddress();
  console.log(`SRXStaking proxy: ${stakingAddress}`);

  // ── Deploy FeeController ─────────────────────────────────────────────────────

  console.log("\nDeploying FeeController (UUPS proxy)...");
  const FeeController = await ethers.getContractFactory("FeeController");
  const feeProxy = await upgrades.deployProxy(
    FeeController,
    [stakingAddress, admin],
    { initializer: "initialize", kind: "uups" }
  );
  await feeProxy.waitForDeployment();
  const feeAddress = await feeProxy.getAddress();
  console.log(`FeeController proxy: ${feeAddress}`);

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
