/**
 * fund_new_presale.js
 *
 * Funds the new PreSaleRound (v2, with tier bonuses) by recovering unallocated
 * SRX from the old PreSaleRound (v1) and transferring the hard cap amount to
 * the new contract.
 *
 * Steps performed:
 *   1. Check old presale SRX balance and total allocated
 *   2. Call recoverSRX(deployer) on old presale → pulls all unallocated SRX to deployer
 *   3. Transfer 400M SRX (hard cap) from deployer to new presale
 *   4. Verify new presale balance
 *
 * Run:
 *   npx hardhat run scripts/ops/fund_new_presale.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const OLD_PRESALE = "0x31cB4Eb87A24E3e677f8B32287056F5a406d4cEe"; // v1 — pre-bonus
const HARD_CAP    = ethers.parseUnits("400000000", 18);            // 400M SRX

async function main() {
  const [deployer] = await ethers.getSigners();

  const tokenAddr      = process.env.SRX_TOKEN_SEPOLIA;
  const newPresaleAddr = process.env.PRESALE_ROUND_SEPOLIA;

  if (!tokenAddr || !newPresaleAddr) {
    throw new Error("SRX_TOKEN_SEPOLIA or PRESALE_ROUND_SEPOLIA not set in .env");
  }

  console.log(`\nNetwork:       ${network.name}`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`SRXToken:      ${tokenAddr}`);
  console.log(`Old Presale:   ${OLD_PRESALE}`);
  console.log(`New Presale:   ${newPresaleAddr}\n`);

  const token      = await ethers.getContractAt("SRXToken",     tokenAddr);
  const oldPresale = await ethers.getContractAt("PreSaleRound", OLD_PRESALE);
  const newPresale = await ethers.getContractAt("PreSaleRound", newPresaleAddr);

  // ── Step 1: State check ────────────────────────────────────────────────────

  const oldBal       = await token.balanceOf(OLD_PRESALE);
  const oldAllocated = await oldPresale.totalAllocated();
  const deployerBal  = await token.balanceOf(deployer.address);
  const newBal       = await token.balanceOf(newPresaleAddr);

  console.log(`── Current State ────────────────────────────────────`);
  console.log(`Old presale SRX:      ${ethers.formatUnits(oldBal, 18)}`);
  console.log(`Old presale allocated:${ethers.formatUnits(oldAllocated, 18)} (in vaults/pending)`);
  console.log(`Deployer SRX:         ${ethers.formatUnits(deployerBal, 18)}`);
  console.log(`New presale SRX:      ${ethers.formatUnits(newBal, 18)}\n`);

  if (newBal >= HARD_CAP) {
    console.log("✅ New presale already funded to hard cap — nothing to do.");
    return;
  }

  // ── Step 2: Recover SRX from old presale ──────────────────────────────────

  if (oldBal > 0n) {
    console.log(`[1/2] Recovering ${ethers.formatUnits(oldBal, 18)} SRX from old presale...`);
    const tx = await oldPresale.recoverSRX(deployer.address);
    await tx.wait();
    const balAfter = await token.balanceOf(deployer.address);
    console.log(`  ✅ Recovered. Deployer SRX: ${ethers.formatUnits(balAfter, 18)}\n`);
  } else {
    console.log(`[1/2] Old presale already empty — skipping recovery.\n`);
  }

  // ── Step 3: Transfer hard cap to new presale ──────────────────────────────

  const deployerBalNow = await token.balanceOf(deployer.address);

  if (deployerBalNow < HARD_CAP) {
    // Transfer whatever is available
    console.log(`⚠️  Deployer holds ${ethers.formatUnits(deployerBalNow, 18)} SRX — less than 400M hard cap.`);
    console.log(`    Transferring all available SRX (${ethers.formatUnits(deployerBalNow, 18)}) to new presale.`);
    const tx = await token.transfer(newPresaleAddr, deployerBalNow);
    await tx.wait();
  } else {
    console.log(`[2/2] Transferring 400,000,000 SRX to new presale...`);
    const tx = await token.transfer(newPresaleAddr, HARD_CAP);
    await tx.wait();
  }

  // ── Step 4: Verify ────────────────────────────────────────────────────────

  const finalBal = await token.balanceOf(newPresaleAddr);
  console.log(`\n✅ New presale funded.`);
  console.log(`   New presale SRX balance: ${ethers.formatUnits(finalBal, 18)}`);
  console.log(`   Hard cap:                ${ethers.formatUnits(HARD_CAP, 18)}`);

  if (finalBal >= HARD_CAP) {
    console.log(`\n✅ Fully funded — ready for investors.`);
  } else {
    console.log(`\n⚠️  Partially funded (${ethers.formatUnits(finalBal, 18)} / 400M). Sufficient for testnet.`);
  }

  console.log(`\nNext: run Phase 11 status check:`);
  console.log(`  npx hardhat run scripts/ops/presale_ops.js --network sepolia`);
}

main().catch((err) => {
  console.error("\n💥 Error:", err.message ?? err);
  process.exit(1);
});
