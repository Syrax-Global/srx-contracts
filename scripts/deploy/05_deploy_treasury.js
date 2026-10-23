/**
 * Step 5 — Deploy SRXTreasury (a plain contract: not upgradeable, no proxy; REG-53)
 *
 * The treasury holds the 900M SRX Treasury & Ops allocation and any
 * platform revenue. Spend is controlled exclusively by the Timelock.
 *
 * ⛔ RUNS RIGHT AFTER STEP 2 — before Step 10 (the Genesis round) and Step 3 (the vesting
 *    vaults), although it is numbered 5. Both of those fix, immutably, the address a revoked
 *    vault's unvested SRX is sent to, and that address must be THIS contract (E-02, review E,
 *    22 Oct 2026): they refuse to run without TREASURY_<NETWORK>. Documented order:
 *    01 → 02 → 05 → 10 → 03 → 04 → 05b → 06 → 06b → 08 (see lib/launch_order.js).
 *
 * After deployment:
 *  - Grant BURN_ROLE on SRXToken to the Treasury address so it can call buyAndBurn.
 *  - SPENDER_ROLE is granted to the Timelock by the constructor.
 *
 * Prerequisites:
 *  - SRXToken deployed (Step 1)
 *  - Governance deployed (Step 2) — TIMELOCK_<NETWORK> set in .env
 *
 * Run: npx hardhat run scripts/deploy/05_deploy_treasury.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS } = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying SRXTreasury on ${network.name}`);

  const srxToken  = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  const timelock  = process.env[`TIMELOCK_${network.name.toUpperCase()}`];
  const admin     = WALLETS.admin;

  if (!srxToken) throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);
  if (!timelock) throw new Error(`TIMELOCK_${network.name.toUpperCase()} not set in .env`);

  // ── Deploy SRXTreasury ───────────────────────────────────────────────────────

  console.log("\nDeploying SRXTreasury...");
  const SRXTreasury = await ethers.getContractFactory("SRXTreasury");
  const treasuryContract = await SRXTreasury.deploy(...[srxToken, admin, timelock]);
  await treasuryContract.waitForDeployment();
  const treasuryAddress = await treasuryContract.getAddress();
  console.log(`SRXTreasury: ${treasuryAddress}`);

  // ── Grant BURN_ROLE on SRXToken to Treasury ──────────────────────────────────

  console.log("\nGranting BURN_ROLE on SRXToken to Treasury...");
  const token = await ethers.getContractAt("SRXToken", srxToken);
  const BURN_ROLE = await token.BURN_ROLE();

  // grantRole on SRXToken is DEFAULT_ADMIN_ROLE-gated, held by WALLETS.admin (the
  // admin Safe on mainnet) — not the deployer. SC-TRUST-002: route through it.
  const batch = createAdminBatch("05_treasury");
  await batch.send(token, "grantRole", [BURN_ROLE, treasuryAddress], "SRXToken.grantRole(BURN_ROLE, Treasury)");
  await batch.flush();

  console.log(`\n✅ SRXTreasury deployed`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`TREASURY_${network.name.toUpperCase()}=${treasuryAddress}`);
  console.log(`\n⛔ Set TREASURY_${network.name.toUpperCase()} BEFORE Step 10 (Genesis round) and Step 3 (vesting).`);
  console.log(`   Both fix their revoke recipient to this contract, immutably, and refuse to run without it.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
