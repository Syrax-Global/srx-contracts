/**
 * Step 3 — Deploy Vesting Vaults + TGEDistributor
 *
 * Deploys one VestingVault per "vault" row of TGE_PLAN (00_config.js), then deploys
 * the TGEDistributor configured with every row of the plan.
 *
 * Vested allocations (get a VestingVault): Founders, Core Team, Seed Investors,
 * Presale (the part after its launch tranche), Ecosystem DAO, Liquidity Reserve.
 *
 * Direct allocations: the presale launch tranche, the liquidity pool and the
 * market-maker inventory (each to a multi-signature wallet), and the Staking,
 * Treasury and Stabilisation Fund contracts.
 *
 * ⭐ The rows are read from TGE_PLAN, not written out here, so this script, the TGE
 *    gate (lib/tge_targets.js) and the generated tokenomics cannot disagree.
 *
 * Prerequisites:
 *  - SRXToken deployed (Step 1) — SRX_TOKEN_<NETWORK> set in .env
 *  - Treasury deployed (Step 4 sets TREASURY_<NETWORK> — run Step 4 first OR
 *    use WALLET_TREASURY as placeholder and upgrade later)
 *
 * Run: npx hardhat run scripts/deploy/03_deploy_vesting.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS, ALLOCATIONS, VESTING, TGE_PLAN } = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying Vesting Vaults + TGEDistributor on ${network.name}`);

  const srxToken  = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  const treasury  = process.env[`TREASURY_${network.name.toUpperCase()}`] || WALLETS.treasury;
  const staking   = process.env[`STAKING_${network.name.toUpperCase()}`]  || WALLETS.staking;
  const admin     = WALLETS.admin;

  if (!srxToken) throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);

  const VestingVault = await ethers.getContractFactory("VestingVault");

  // ── Deploy vesting vaults ─────────────────────────────────────────────────

  console.log("\nDeploying VestingVaults...");

  const vaults = {};        // label → vault address
  const vaultContracts = {}; // label → contract
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    const v = VESTING[row.schedule];
    const vault = await VestingVault.deploy(
      srxToken, WALLETS[row.beneficiary], admin,
      v.cliffDuration, v.vestingDuration, v.tgeUnlockBps
    );
    await vault.waitForDeployment();
    vaults[row.label] = await vault.getAddress();
    vaultContracts[row.label] = vault;
    console.log(`${(row.label + " vault:").padEnd(24)}${vaults[row.label]}`);
  }

  // ── Declare each vault's intended allocation ──────────────────────────────
  //
  // ⛔ WITHOUT THIS, A VAULT'S GRANT IS "WHATEVER HAPPENS TO BE IN IT".
  //    triggerTGE() snapshots the balance, so anything transferred in beforehand
  //    -- including a misdirected transfer from a third party -- silently becomes
  //    part of the beneficiary's grant and vests to them. The only previous route
  //    to recovering it was revoke(), which destroys the vesting schedule to undo
  //    somebody's typo.
  //
  // ⭐ Declaring it up front also makes an UNDERFUNDED vault fail here, at setup,
  //    instead of silently shorting the beneficiary years into the schedule.

  // declareExpectedAllocation() is gated by each vault's immutable `admin` field
  // (set to WALLETS.admin above), not the deployer — same SC-TRUST-002 pattern as
  // TGEDistributor.setAllocations() below. One batch covers both groups of calls.
  const batch = createAdminBatch("03_vesting");

  console.log("\nDeclaring expected allocations on each vault...");
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    const amount = ALLOCATIONS[row.allocation];
    await batch.send(vaultContracts[row.label], "declareExpectedAllocation", [amount], `${row.label} vault: declareExpectedAllocation(${ethers.formatUnits(amount, 18)} SRX)`);
  }

  // ── Deploy TGEDistributor ─────────────────────────────────────────────────

  console.log("\nDeploying TGEDistributor...");
  const TGEDistributor = await ethers.getContractFactory("TGEDistributor");
  const tge = await TGEDistributor.deploy(srxToken, admin);
  await tge.waitForDeployment();
  const tgeAddress = await tge.getAddress();
  console.log(`TGEDistributor:       ${tgeAddress}`);

  // ── Configure allocations ─────────────────────────────────────────────────
  //
  // 06_execute_tge.js sets the final list again from lib/tge_targets.js, after
  // every destination exists and has been checked; this first setting uses what is
  // known now (the Stabilisation Fund is deployed later, in step 05b).

  console.log("\nConfiguring allocations on TGEDistributor...");

  const contractDestination = { Staking: staking, Treasury: treasury, StabilisationFund: WALLETS.strategic };
  const allocations = TGE_PLAN.map((row) => ({
    destination:
      row.kind === "vault"  ? vaults[row.label] :
      row.kind === "wallet" ? WALLETS[row.wallet] :
      contractDestination[row.label],
    amount: ALLOCATIONS[row.allocation],
    isVestingVault: row.kind === "vault",
    label: row.label,
  }));

  // TGEDistributor.setAllocations() is gated the same way — its immutable
  // `admin` field is WALLETS.admin (passed above), not the deployer.
  await batch.send(tge, "setAllocations", [allocations], "TGEDistributor.setAllocations(...)");
  await batch.flush();

  console.log(`\n✅ All vesting vaults and TGEDistributor deployed`);
  console.log(`\n⚠️  Save to .env:`);
  const NET = network.name.toUpperCase();
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    console.log(`${row.vaultEnv}_${NET}=${vaults[row.label]}`);
  }
  console.log(`TGE_DISTRIBUTOR_${NET}=${tgeAddress}`);
  console.log(`\nNext steps:`);
  console.log(`  4. Deploy Staking + FeeController (Step 4)`);
  console.log(`  5. Deploy Treasury (Step 5)`);
  console.log(`  6. Execute TGE (Step 6) — mints + distributes + triggers vesting`);

  return { vaults, tgeAddress };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
