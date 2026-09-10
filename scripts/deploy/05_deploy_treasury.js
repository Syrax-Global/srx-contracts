/**
 * Step 5 — Deploy SRXTreasury (UUPS proxy)
 *
 * The treasury holds the 900M SRX Treasury & Ops allocation and any
 * platform revenue. Spend is controlled exclusively by the Timelock.
 *
 * After deployment:
 *  - Grant BURN_ROLE on SRXToken to the Treasury address so it can call buyAndBurn.
 *  - SPENDER_ROLE is granted to the Timelock at initialization.
 *
 * Prerequisites:
 *  - SRXToken deployed (Step 1)
 *  - Governance deployed (Step 2) — TIMELOCK_<NETWORK> set in .env
 *
 * Run: npx hardhat run scripts/deploy/05_deploy_treasury.js --network sepolia
 */
const { ethers, upgrades, network } = require("hardhat");
const { WALLETS } = require("./00_config");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying SRXTreasury on ${network.name}`);

  const srxToken  = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  const timelock  = process.env[`TIMELOCK_${network.name.toUpperCase()}`];
  const admin     = WALLETS.admin;

  if (!srxToken) throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);
  if (!timelock) throw new Error(`TIMELOCK_${network.name.toUpperCase()} not set in .env`);

  // ── Deploy SRXTreasury ───────────────────────────────────────────────────────

  console.log("\nDeploying SRXTreasury (UUPS proxy)...");
  const SRXTreasury = await ethers.getContractFactory("SRXTreasury");
  const treasuryProxy = await upgrades.deployProxy(
    SRXTreasury,
    [srxToken, admin, timelock],
    { initializer: "initialize", kind: "uups" }
  );
  await treasuryProxy.waitForDeployment();
  const treasuryAddress = await treasuryProxy.getAddress();
  console.log(`SRXTreasury proxy: ${treasuryAddress}`);

  // ── Grant BURN_ROLE on SRXToken to Treasury ──────────────────────────────────

  console.log("\nGranting BURN_ROLE on SRXToken to Treasury...");
  const token = await ethers.getContractAt("SRXToken", srxToken);
  const BURN_ROLE = await token.BURN_ROLE();
  await (await token.grantRole(BURN_ROLE, treasuryAddress)).wait();
  console.log(`BURN_ROLE granted to Treasury`);

  console.log(`\n✅ SRXTreasury deployed`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`TREASURY_${network.name.toUpperCase()}=${treasuryAddress}`);
  console.log(`\n⚠️  If TGEDistributor uses WALLET_TREASURY as placeholder, re-run Step 3`);
  console.log(`    with TREASURY_${network.name.toUpperCase()} set, or update the allocation manually`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
