/**
 * Step 3 — Deploy Vesting Vaults + TGEDistributor
 *
 * Deploys one VestingVault per vested allocation, then deploys the
 * TGEDistributor configured with all allocations.
 *
 * Vested allocations (get a VestingVault):
 *  - Founders, Core Team, Seed Investors, Presale, Ecosystem DAO
 *
 * Direct allocations (go straight to the destination):
 *  - Liquidity wallet, Staking contract, Treasury contract, Strategic wallet
 *
 * Prerequisites:
 *  - SRXToken deployed (Step 1) — SRX_TOKEN_<NETWORK> set in .env
 *  - Treasury deployed (Step 4 sets TREASURY_<NETWORK> — run Step 4 first OR
 *    use WALLET_TREASURY as placeholder and upgrade later)
 *
 * Run: npx hardhat run scripts/deploy/03_deploy_vesting.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS, ALLOCATIONS, VESTING } = require("./00_config");

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

  const vaults = {};

  // Founders
  const foundersVault = await VestingVault.deploy(
    srxToken, WALLETS.founders, admin,
    VESTING.founders.cliffDuration,
    VESTING.founders.vestingDuration,
    VESTING.founders.tgeUnlockBps
  );
  await foundersVault.waitForDeployment();
  vaults.founders = await foundersVault.getAddress();
  console.log(`Founders vault:       ${vaults.founders}`);

  // Core Team
  const coreTeamVault = await VestingVault.deploy(
    srxToken, WALLETS.coreTeam, admin,
    VESTING.coreTeam.cliffDuration,
    VESTING.coreTeam.vestingDuration,
    VESTING.coreTeam.tgeUnlockBps
  );
  await coreTeamVault.waitForDeployment();
  vaults.coreTeam = await coreTeamVault.getAddress();
  console.log(`Core Team vault:      ${vaults.coreTeam}`);

  // Seed Investors
  const seedVault = await VestingVault.deploy(
    srxToken, WALLETS.seedInvestors, admin,
    VESTING.seedInvestors.cliffDuration,
    VESTING.seedInvestors.vestingDuration,
    VESTING.seedInvestors.tgeUnlockBps
  );
  await seedVault.waitForDeployment();
  vaults.seedInvestors = await seedVault.getAddress();
  console.log(`Seed Investors vault: ${vaults.seedInvestors}`);

  // Presale
  const presaleVault = await VestingVault.deploy(
    srxToken, WALLETS.presale, admin,
    VESTING.presale.cliffDuration,
    VESTING.presale.vestingDuration,
    VESTING.presale.tgeUnlockBps
  );
  await presaleVault.waitForDeployment();
  vaults.presale = await presaleVault.getAddress();
  console.log(`Presale vault:        ${vaults.presale}`);

  // Ecosystem DAO
  const ecosystemVault = await VestingVault.deploy(
    srxToken, WALLETS.ecosystem, admin,
    VESTING.ecosystem.cliffDuration,
    VESTING.ecosystem.vestingDuration,
    VESTING.ecosystem.tgeUnlockBps
  );
  await ecosystemVault.waitForDeployment();
  vaults.ecosystem = await ecosystemVault.getAddress();
  console.log(`Ecosystem vault:      ${vaults.ecosystem}`);

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

  console.log("\nDeclaring expected allocations on each vault...");
  const declarations = [
    ["Founders",      foundersVault,  ALLOCATIONS.founders],
    ["CoreTeam",      coreTeamVault,  ALLOCATIONS.coreTeam],
    ["SeedInvestors", seedVault,      ALLOCATIONS.seedInvestors],
    ["Presale",       presaleVault,   ALLOCATIONS.presale],
    ["EcosystemDAO",  ecosystemVault, ALLOCATIONS.ecosystem],
  ];
  for (const [label, vault, amount] of declarations) {
    await (await vault.declareExpectedAllocation(amount)).wait();
    console.log(`  ✓ ${label.padEnd(14)} ${ethers.formatUnits(amount, 18)} SRX`);
  }

  // ── Deploy TGEDistributor ─────────────────────────────────────────────────

  console.log("\nDeploying TGEDistributor...");
  const TGEDistributor = await ethers.getContractFactory("TGEDistributor");
  const tge = await TGEDistributor.deploy(srxToken, admin);
  await tge.waitForDeployment();
  const tgeAddress = await tge.getAddress();
  console.log(`TGEDistributor:       ${tgeAddress}`);

  // ── Configure allocations ─────────────────────────────────────────────────

  console.log("\nConfiguring allocations on TGEDistributor...");

  const allocations = [
    { destination: vaults.founders,      amount: ALLOCATIONS.founders,      isVestingVault: true,  label: "Founders" },
    { destination: vaults.coreTeam,      amount: ALLOCATIONS.coreTeam,      isVestingVault: true,  label: "CoreTeam" },
    { destination: vaults.seedInvestors, amount: ALLOCATIONS.seedInvestors, isVestingVault: true,  label: "SeedInvestors" },
    { destination: vaults.presale,       amount: ALLOCATIONS.presale,       isVestingVault: true,  label: "Presale" },
    { destination: vaults.ecosystem,     amount: ALLOCATIONS.ecosystem,     isVestingVault: true,  label: "EcosystemDAO" },
    { destination: WALLETS.liquidity,    amount: ALLOCATIONS.liquidity,     isVestingVault: false, label: "Liquidity" },
    { destination: staking,              amount: ALLOCATIONS.staking,       isVestingVault: false, label: "Staking" },
    { destination: treasury,             amount: ALLOCATIONS.treasury,      isVestingVault: false, label: "Treasury" },
    { destination: WALLETS.strategic,    amount: ALLOCATIONS.strategic,     isVestingVault: false, label: "Strategic" },
  ];

  await (await tge.setAllocations(allocations)).wait();
  console.log("✅ Allocations configured");

  console.log(`\n✅ All vesting vaults and TGEDistributor deployed`);
  console.log(`\n⚠️  Save to .env:`);
  const NET = network.name.toUpperCase();
  console.log(`VESTING_FOUNDERS_${NET}=${vaults.founders}`);
  console.log(`VESTING_CORE_TEAM_${NET}=${vaults.coreTeam}`);
  console.log(`VESTING_SEED_${NET}=${vaults.seedInvestors}`);
  console.log(`VESTING_PRESALE_${NET}=${vaults.presale}`);
  console.log(`VESTING_ECOSYSTEM_${NET}=${vaults.ecosystem}`);
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
