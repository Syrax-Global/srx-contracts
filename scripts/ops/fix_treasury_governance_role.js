/**
 * fix_treasury_governance_role.js
 *
 * One-shot fix: grants GOVERNANCE_ROLE to the Timelock on SRXTreasury.
 * The main pre_mainnet_roles.js run consistently timed out on this single
 * transaction. This script targets it in isolation with explicit gas settings.
 *
 * Run:
 *   npx hardhat run scripts/ops/fix_treasury_governance_role.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

async function main() {
  const [deployer] = await ethers.getSigners();

  const treasuryAddr = process.env.TREASURY_SEPOLIA_TGE;
  const timelockAddr = process.env.TIMELOCK_SEPOLIA_TGE;

  if (!treasuryAddr || !timelockAddr) {
    console.error("Fatal: TREASURY_SEPOLIA_TGE or TIMELOCK_SEPOLIA_TGE not set in .env");
    process.exit(1);
  }

  const GOVERNANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNANCE_ROLE"));

  console.log(`\nNetwork:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Treasury:  ${treasuryAddr}`);
  console.log(`Timelock:  ${timelockAddr}\n`);

  const treasury = await ethers.getContractAt("SRXTreasury", treasuryAddr);

  // Pre-check
  const alreadyHas = await treasury.hasRole(GOVERNANCE_ROLE, timelockAddr);
  if (alreadyHas) {
    console.log("✅ Timelock already has GOVERNANCE_ROLE on SRXTreasury — nothing to do.");
    return;
  }

  // Check deployer has DEFAULT_ADMIN_ROLE
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const isAdmin = await treasury.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
  if (!isAdmin) {
    console.error("❌ Deployer does not have DEFAULT_ADMIN_ROLE on SRXTreasury — cannot grant.");
    process.exit(1);
  }

  console.log("Deployer has DEFAULT_ADMIN_ROLE ✓");
  console.log("Timelock does not yet have GOVERNANCE_ROLE — granting now...\n");

  // Get current gas price and add 30% buffer to ensure quick inclusion
  const feeData    = await ethers.provider.getFeeData();
  const gasPrice   = feeData.gasPrice
    ? (feeData.gasPrice * 130n) / 100n
    : ethers.parseUnits("10", "gwei");

  console.log(`Gas price (+ 30% buffer): ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  const tx = await treasury.grantRole(GOVERNANCE_ROLE, timelockAddr, {
    gasPrice,
    gasLimit: 100_000,
  });

  console.log(`TX sent: ${tx.hash}`);
  console.log("Waiting for confirmation...\n");

  const rx = await tx.wait();
  console.log(`✅ Confirmed in block ${rx.blockNumber}`);

  // Verify
  const confirmed = await treasury.hasRole(GOVERNANCE_ROLE, timelockAddr);
  if (confirmed) {
    console.log("✅ GOVERNANCE_ROLE verified on SRXTreasury → Timelock\n");
    console.log("Now re-run pre_mainnet_roles.js to confirm 19/19:");
    console.log("  npx hardhat run scripts/ops/pre_mainnet_roles.js --network sepolia");
  } else {
    console.error("❌ Role grant did not take effect — check the transaction on Etherscan.");
  }
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err.message ?? err);
  process.exit(1);
});
