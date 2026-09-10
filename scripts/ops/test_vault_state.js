/**
 * Test: Inspect and exercise the already-deployed VestingVault on Sepolia.
 *
 * The deployer investor already has a vault at:
 *   0x3012adf23ea2A4D81AF30aD4e935AF1a194613b0
 *
 * This script checks vault state, triggers TGE if not already triggered,
 * and checks what is claimable.
 *
 * Run: npx hardhat run scripts/ops/test_vault_state.js --network sepolia
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();

// The vault deployed in the previous session
const VAULT_ADDRESS = "0x3012adf23ea2A4D81AF30aD4e935AF1a194613b0";

async function main() {
  const [deployer] = await ethers.getSigners();
  const tokenAddr  = process.env.SRX_TOKEN_SEPOLIA;
  if (!tokenAddr) throw new Error("SRX_TOKEN_SEPOLIA not set in .env");

  const vault = await ethers.getContractAt("VestingVault", VAULT_ADDRESS);
  const token = await ethers.getContractAt("SRXToken",     tokenAddr);

  console.log(`\nNetwork:     ${network.name}`);
  console.log(`Deployer:    ${deployer.address}`);
  console.log(`Vault:       ${VAULT_ADDRESS}\n`);

  // ── Vault state ─────────────────────────────────────────────────────────────
  const beneficiary      = await vault.beneficiary();
  const admin            = await vault.admin();
  const cliffDuration    = await vault.cliffDuration();
  const vestingDuration  = await vault.vestingDuration();
  const tgeUnlockBps     = await vault.tgeUnlockBps();
  const tgeTriggered     = await vault.tgeTriggered();
  const totalAllocation  = await vault.totalAllocation();
  const released         = await vault.released();
  const revoked          = await vault.revoked();
  const vaultBal         = await token.balanceOf(VAULT_ADDRESS);

  console.log("── Vault Configuration ────────────────────────────────────");
  console.log(`Beneficiary:      ${beneficiary}`);
  console.log(`Admin:            ${admin}`);
  console.log(`Cliff:            ${Number(cliffDuration) / 86400} days`);
  console.log(`Vesting:          ${Number(vestingDuration) / 86400} days`);
  console.log(`TGE unlock:       ${Number(tgeUnlockBps) / 100}%`);
  console.log(`\n── Vault State ─────────────────────────────────────────────`);
  console.log(`TGE triggered:    ${tgeTriggered}`);
  console.log(`Total allocation: ${ethers.formatUnits(totalAllocation, 18)} SRX`);
  console.log(`Released so far:  ${ethers.formatUnits(released, 18)} SRX`);
  console.log(`Revoked:          ${revoked}`);
  console.log(`SRX in vault:     ${ethers.formatUnits(vaultBal, 18)} SRX`);

  if (tgeTriggered) {
    const tgeTs    = await vault.tgeTimestamp();
    const claimNow = await vault.claimableNow();
    console.log(`TGE timestamp:    ${new Date(Number(tgeTs) * 1000).toISOString()}`);
    console.log(`Claimable now:    ${ethers.formatUnits(claimNow, 18)} SRX`);
  }

  // ── Trigger TGE if not yet done ─────────────────────────────────────────────
  if (!tgeTriggered) {
    console.log("\n── Triggering TGE on vault ────────────────────────────────");
    console.log("(Only vault admin can call triggerTGE)");

    if (deployer.address.toLowerCase() !== admin.toLowerCase()) {
      console.log(`⚠️  Deployer (${deployer.address}) is not the vault admin (${admin}).`);
      console.log("    Switch to the admin wallet to trigger TGE.");
    } else {
      const tx      = await vault.triggerTGE();
      const receipt = await tx.wait();
      const tgeTs   = await vault.tgeTimestamp();
      console.log(`✅ TGE triggered — block ${receipt.blockNumber}`);
      console.log(`   TGE timestamp: ${new Date(Number(tgeTs) * 1000).toISOString()}`);

      const claimNow = await vault.claimableNow();
      console.log(`   Claimable now: ${ethers.formatUnits(claimNow, 18)} SRX`);
    }
  }

  // ── Try release if there is anything claimable ───────────────────────────────
  const claimableNow = tgeTriggered ? await vault.claimableNow() : 0n;

  if (claimableNow > 0n) {
    console.log(`\n── Releasing ${ethers.formatUnits(claimableNow, 18)} SRX ──────────────────────────`);
    if (deployer.address.toLowerCase() !== beneficiary.toLowerCase()) {
      console.log(`⚠️  Deployer is not the beneficiary (${beneficiary}).`);
      console.log("    Switch to beneficiary wallet to call release().");
    } else {
      const balBefore = await token.balanceOf(deployer.address);
      const tx        = await vault.release();
      await tx.wait();
      const balAfter  = await token.balanceOf(deployer.address);
      console.log(`✅ Released ${ethers.formatUnits(balAfter - balBefore, 18)} SRX`);
      console.log(`   New vault balance: ${ethers.formatUnits(await token.balanceOf(VAULT_ADDRESS), 18)} SRX`);
    }
  } else if (tgeTriggered) {
    console.log("\nℹ️  Nothing claimable yet — cliff may not have passed.");
    const tgeTs       = await vault.tgeTimestamp();
    const cliffEnd    = Number(tgeTs) + Number(cliffDuration);
    const now         = Math.floor(Date.now() / 1000);
    const daysLeft    = ((cliffEnd - now) / 86400).toFixed(1);
    if (cliffEnd > now) {
      console.log(`   Cliff ends: ${new Date(cliffEnd * 1000).toISOString()} (in ${daysLeft} days)`);
    }
  }

  // ── Revoke test (admin only, non-destructive check) ──────────────────────────
  console.log("\n── Revoke capability check ────────────────────────────────");
  if (deployer.address.toLowerCase() === admin.toLowerCase()) {
    console.log("Deployer IS the vault admin — revoke() is callable.");
    console.log("(Not calling it — would stop vesting. Test this on a throwaway vault.)");
  } else {
    console.log(`Vault admin is ${admin} — revoke must be called from that address.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
