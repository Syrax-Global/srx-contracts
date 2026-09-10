/**
 * Testnet TGE Stack — Full fresh deployment for TGE sequence testing.
 *
 * The main SRXToken on Sepolia has genesis already complete (used for presale
 * testing). To test the full TGE sequence, this script deploys a complete
 * parallel stack with a fresh SRXToken.
 *
 * Deploys in order:
 *   1. SRXToken (fresh — genesis not yet called)
 *   2. SRXTimelock (60s delay — testnet only)
 *   3. SRXGovernor
 *   4. VestingVaults (Founders, CoreTeam, Seed, Presale, Ecosystem)
 *   5. TGEDistributor
 *   6. SRXStaking + FeeController
 *   7. SRXTreasury
 *   8. StabilisationFund
 *   9. Executes TGE: setAllocations → genesis → distribute → triggerTGE vaults
 *  10. Verifies all balances
 *
 * All deployed addresses are printed at the end. Save the ones you need
 * for subsequent staking/SSF tests.
 *
 * ⚠️  Uses a 60-second Timelock delay (not 48h) — TESTNET ONLY.
 * ⚠️  Does NOT touch the existing SRXToken or PreSaleRound on Sepolia.
 *
 * Run: npx hardhat run scripts/ops/deploy_tge_teststack.js --network sepolia
 */
const { ethers, upgrades, network } = require("hardhat");
require("dotenv").config();
const { WALLETS, ALLOCATIONS, VESTING, SSF, LZ_ENDPOINTS, LZ_EIDS } = require("../deploy/00_config");

const TESTNET_TIMELOCK_DELAY = 60; // 60 seconds for testnet

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  const NET = net.toUpperCase();

  if (net === "ethereum" || net === "bsc") {
    throw new Error("This script is for TESTNET ONLY. Use individual deploy scripts for mainnet.");
  }

  const lzEndpoint = LZ_ENDPOINTS[net];
  if (!lzEndpoint) throw new Error(`No LZ endpoint configured for ${net}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  TESTNET TGE STACK — ${NET}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  const admin = WALLETS.admin;
  const addrs = {};

  // ── 1. SRXToken ─────────────────────────────────────────────────────────────
  console.log("[1/9] Deploying SRXToken...");
  const SRXToken = await ethers.getContractFactory("SRXToken");
  const token = await SRXToken.deploy(lzEndpoint, admin);
  await token.waitForDeployment();
  addrs.token = await token.getAddress();
  console.log(`  SRXToken: ${addrs.token}`);

  // ── 2. SRXTimelock ───────────────────────────────────────────────────────────
  console.log("\n[2/9] Deploying SRXTimelock (60s delay)...");
  const SRXTimelock = await ethers.getContractFactory("SRXTimelock");
  const timelock = await SRXTimelock.deploy(
    TESTNET_TIMELOCK_DELAY,
    [],
    [ethers.ZeroAddress],
    admin
  );
  await timelock.waitForDeployment();
  addrs.timelock = await timelock.getAddress();
  console.log(`  SRXTimelock: ${addrs.timelock}`);

  // ── 3. SRXGovernor ───────────────────────────────────────────────────────────
  console.log("\n[3/9] Deploying SRXGovernor...");
  const SRXGovernor = await ethers.getContractFactory("SRXGovernor");
  const governor = await SRXGovernor.deploy(addrs.token, addrs.timelock);
  await governor.waitForDeployment();
  addrs.governor = await governor.getAddress();
  console.log(`  SRXGovernor: ${addrs.governor}`);

  // Wire governor as proposer
  const PROPOSER_ROLE  = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  await (await timelock.grantRole(PROPOSER_ROLE,  addrs.governor)).wait();
  await (await timelock.grantRole(CANCELLER_ROLE, admin)).wait();
  console.log(`  Governor wired as proposer on Timelock`);

  // ── 4. VestingVaults ─────────────────────────────────────────────────────────
  console.log("\n[4/9] Deploying VestingVaults...");
  const VestingVault = await ethers.getContractFactory("VestingVault");

  const vaultDefs = [
    { key: "founders",     cfg: VESTING.founders,     beneficiary: WALLETS.founders     },
    { key: "coreTeam",     cfg: VESTING.coreTeam,     beneficiary: WALLETS.coreTeam     },
    { key: "seedInvestors",cfg: VESTING.seedInvestors, beneficiary: WALLETS.seedInvestors},
    { key: "presale",      cfg: VESTING.presale,       beneficiary: WALLETS.presale      },
    { key: "ecosystem",    cfg: VESTING.ecosystem,     beneficiary: WALLETS.ecosystem    },
  ];

  addrs.vaults = {};
  for (const { key, cfg, beneficiary } of vaultDefs) {
    const v = await VestingVault.deploy(
      addrs.token, beneficiary, admin,
      cfg.cliffDuration, cfg.vestingDuration, cfg.tgeUnlockBps
    );
    await v.waitForDeployment();
    addrs.vaults[key] = await v.getAddress();
    console.log(`  ${key.padEnd(14)}: ${addrs.vaults[key]}`);
  }

  // ── 5. TGEDistributor ────────────────────────────────────────────────────────
  console.log("\n[5/9] Deploying TGEDistributor...");
  const TGEDistributor = await ethers.getContractFactory("TGEDistributor");
  const tge = await TGEDistributor.deploy(addrs.token, admin);
  await tge.waitForDeployment();
  addrs.tge = await tge.getAddress();
  console.log(`  TGEDistributor: ${addrs.tge}`);

  // ── 6. SRXStaking + FeeController ────────────────────────────────────────────
  console.log("\n[6/9] Deploying SRXStaking + FeeController (UUPS proxies)...");

  // SRXStaking
  const SRXStakingF  = await ethers.getContractFactory("SRXStaking");
  const stakingProxy = await upgrades.deployProxy(
    SRXStakingF, [addrs.token, admin], { initializer: "initialize", kind: "uups" }
  );
  await stakingProxy.waitForDeployment();
  addrs.staking = await stakingProxy.getAddress();
  console.log(`  SRXStaking proxy:    ${addrs.staking}`);

  // FeeController
  const FeeControllerF = await ethers.getContractFactory("FeeController");
  const feeProxy       = await upgrades.deployProxy(
    FeeControllerF, [addrs.staking, admin], { initializer: "initialize", kind: "uups" }
  );
  await feeProxy.waitForDeployment();
  addrs.feeController = await feeProxy.getAddress();
  console.log(`  FeeController proxy: ${addrs.feeController}`);

  // Grant GOVERNANCE_ROLE to Timelock on staking
  const staking  = await ethers.getContractAt("SRXStaking", addrs.staking);
  const GOV_ROLE = await staking.GOVERNANCE_ROLE();
  await (await staking.grantRole(GOV_ROLE, addrs.timelock)).wait();
  console.log(`  GOVERNANCE_ROLE → Timelock on SRXStaking`);

  // ── 7. SRXTreasury ───────────────────────────────────────────────────────────
  console.log("\n[7/9] Deploying SRXTreasury (UUPS proxy)...");
  const SRXTreasuryF  = await ethers.getContractFactory("SRXTreasury");
  const treasuryProxy = await upgrades.deployProxy(
    SRXTreasuryF, [addrs.token, admin, addrs.timelock], { initializer: "initialize", kind: "uups" }
  );
  await treasuryProxy.waitForDeployment();
  addrs.treasury = await treasuryProxy.getAddress();
  console.log(`  SRXTreasury proxy: ${addrs.treasury}`);

  // Grant BURN_ROLE to treasury (needed for executeBuyAndBurn)
  const tokenContract = await ethers.getContractAt("SRXToken", addrs.token);
  const BURN_ROLE = await tokenContract.BURN_ROLE();
  await (await tokenContract.grantRole(BURN_ROLE, addrs.treasury)).wait();
  console.log(`  BURN_ROLE → Treasury on SRXToken`);

  // ── 8. StabilisationFund ─────────────────────────────────────────────────────
  console.log("\n[8/9] Deploying StabilisationFund (UUPS proxy)...");
  const SSFF     = await ethers.getContractFactory("StabilisationFund");
  const ssfProxy = await upgrades.deployProxy(
    SSFF,
    [addrs.token, admin, SSF.MAX_DEPLOYER_BPS, SSF.MAX_GUARDIAN_BPS, SSF.WITHDRAW_LOCK_DURATION],
    { initializer: "initialize", kind: "uups" }
  );
  await ssfProxy.waitForDeployment();
  addrs.ssf = await ssfProxy.getAddress();
  console.log(`  StabilisationFund proxy: ${addrs.ssf}`);

  const ssf    = await ethers.getContractAt("StabilisationFund", addrs.ssf);
  const ssfGov = await ssf.GOVERNANCE_ROLE();
  await (await ssf.grantRole(ssfGov, addrs.timelock)).wait();
  console.log(`  GOVERNANCE_ROLE → Timelock on StabilisationFund`);

  // ── 9. Execute TGE ───────────────────────────────────────────────────────────
  console.log("\n[9/9] Executing TGE...");

  // Step 0: setAllocations (strategic → SSF)
  console.log("  [9a] setAllocations...");
  const allocations = [
    { destination: addrs.vaults.founders,      amount: ALLOCATIONS.founders,      isVestingVault: true,  label: "Founders"         },
    { destination: addrs.vaults.coreTeam,      amount: ALLOCATIONS.coreTeam,      isVestingVault: true,  label: "CoreTeam"         },
    { destination: addrs.vaults.seedInvestors, amount: ALLOCATIONS.seedInvestors, isVestingVault: true,  label: "SeedInvestors"    },
    { destination: addrs.vaults.presale,       amount: ALLOCATIONS.presale,       isVestingVault: true,  label: "Presale"          },
    { destination: addrs.vaults.ecosystem,     amount: ALLOCATIONS.ecosystem,     isVestingVault: true,  label: "EcosystemDAO"     },
    { destination: WALLETS.liquidity,          amount: ALLOCATIONS.liquidity,     isVestingVault: false, label: "Liquidity"        },
    { destination: addrs.staking,             amount: ALLOCATIONS.staking,       isVestingVault: false, label: "Staking"          },
    { destination: addrs.treasury,            amount: ALLOCATIONS.treasury,      isVestingVault: false, label: "Treasury"         },
    { destination: addrs.ssf,                 amount: ALLOCATIONS.strategic,     isVestingVault: false, label: "StabilisationFund"},
  ];
  await (await tge.setAllocations(allocations)).wait();
  console.log("  ✅ Allocations set");

  // Step 1: genesis
  console.log("  [9b] genesis()...");
  await (await tokenContract.genesis(addrs.tge)).wait();
  const distBal = await tokenContract.balanceOf(addrs.tge);
  console.log(`  ✅ 10,000,000,000 SRX minted → TGEDistributor (balance: ${ethers.formatUnits(distBal, 18)})`);

  // Step 2: distribute
  console.log("  [9c] distribute()...");
  await (await tge.distribute()).wait();
  const afterBal = await tokenContract.balanceOf(addrs.tge);
  console.log(`  ✅ Distribution complete (TGEDistributor balance: ${ethers.formatUnits(afterBal, 18)} — expect 0)`);

  // Step 3: triggerTGE on each vault
  console.log("  [9d] Triggering TGE on vesting vaults...");
  for (const [key, addr] of Object.entries(addrs.vaults)) {
    const vault = await ethers.getContractAt("VestingVault", addr);
    const bal   = await tokenContract.balanceOf(addr);
    await (await vault.triggerTGE()).wait();
    const ts  = await vault.tgeTimestamp();
    console.log(`  ✅ ${key.padEnd(14)}: ${ethers.formatUnits(bal, 18).padStart(16)} SRX  TGE triggered @ ${new Date(Number(ts) * 1000).toISOString().slice(0,19)}Z`);
  }

  // Step 4: register staking pool
  console.log("  [9e] Registering staking incentive pool...");
  const stakingBal = await tokenContract.balanceOf(addrs.staking);
  await (await staking.notifyRewardAmount(stakingBal)).wait();
  console.log(`  ✅ rewardPool = ${ethers.formatUnits(await staking.rewardPool(), 18)} SRX`);

  // ── Verification ─────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("  POST-TGE VERIFICATION");
  console.log(`${"=".repeat(60)}`);

  const checks = [
    { label: "StabilisationFund", addr: addrs.ssf,      expected: ALLOCATIONS.strategic  },
    { label: "SRXStaking",        addr: addrs.staking,  expected: ALLOCATIONS.staking    },
    { label: "SRXTreasury",       addr: addrs.treasury, expected: ALLOCATIONS.treasury   },
    { label: "TGEDistributor",    addr: addrs.tge,      expected: 0n                     },
  ];

  let allOk = true;
  for (const { label, addr, expected } of checks) {
    const bal = await tokenContract.balanceOf(addr);
    const ok  = bal === expected;
    if (!ok) allOk = false;
    console.log(`  ${label.padEnd(20)}: ${ethers.formatUnits(bal, 18).padStart(16)} SRX  ${ok ? "✅" : "❌"}`);
  }

  console.log(`\n  Total supply: ${ethers.formatUnits(await tokenContract.totalSupply(), 18)} SRX`);
  console.log(`  SSF srxBalance(): ${ethers.formatUnits(await ssf.srxBalance(), 18)} SRX`);

  // ── Address summary ──────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("  DEPLOYED ADDRESSES — save for follow-up tests");
  console.log(`${"=".repeat(60)}`);
  console.log(`SRX_TOKEN_${NET}_TGE=${addrs.token}`);
  console.log(`TIMELOCK_${NET}_TGE=${addrs.timelock}`);
  console.log(`GOVERNOR_${NET}_TGE=${addrs.governor}`);
  console.log(`TGE_DISTRIBUTOR_${NET}_TGE=${addrs.tge}`);
  console.log(`STAKING_${NET}_TGE=${addrs.staking}`);
  console.log(`FEE_CONTROLLER_${NET}_TGE=${addrs.feeController}`);
  console.log(`TREASURY_${NET}_TGE=${addrs.treasury}`);
  console.log(`STABILISATION_FUND_${NET}_TGE=${addrs.ssf}`);
  for (const [key, addr] of Object.entries(addrs.vaults)) {
    console.log(`VAULT_${key.toUpperCase()}_${NET}_TGE=${addr}`);
  }

  if (allOk) {
    console.log(`\n✅ TGE STACK DEPLOYED AND VERIFIED SUCCESSFULLY`);
  } else {
    console.log(`\n❌ SOME BALANCES INCORRECT — review output above`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
