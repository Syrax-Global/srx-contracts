/**
 * Verify all deployed SRX ecosystem contracts on a block explorer.
 *
 * Reads contract addresses from .env and matches them with the correct
 * constructor arguments so Etherscan / BscScan can verify the source.
 *
 * Supported networks: sepolia, bscTestnet, zkSyncSepolia, ethereum, bsc
 *
 * Usage:
 *   npx hardhat run scripts/verify/verify_all.js --network sepolia
 *
 * Notes on UUPS proxy contracts (SRXStaking, FeeController, SRXTreasury):
 *   This script verifies the implementation contract.
 *   After the implementation is verified, open the proxy address on the
 *   block explorer and click "Is this a proxy?" — the explorer will
 *   automatically link the proxy to its verified implementation.
 *
 * If a contract is already verified the error is caught and the script
 * continues. All failures are collected and printed at the end.
 */

const { ethers, network, run } = require("hardhat");
const { LZ_ENDPOINTS, WALLETS, VESTING, GOVERNANCE } = require("../deploy/00_config");

// ── Helpers ────────────────────────────────────────────────────────────────────

function envOpt(key) {
  return process.env[key] || null;
}

function envReq(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

/** Read the ERC-1967 implementation slot from a proxy address. */
async function readImplAddress(proxyAddr) {
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await ethers.provider.getStorage(proxyAddr, IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(26));
}

/**
 * Attempt to verify a contract.  Catches "already verified" and source-match
 * errors so the script continues to the next contract.
 */
async function verify(label, address, constructorArguments) {
  if (!address) {
    console.log(`  [SKIP]  ${label} — address not set in .env`);
    return { label, status: "skipped" };
  }

  process.stdout.write(`  Verifying ${label} (${address}) ... `);
  try {
    await run("verify:verify", { address, constructorArguments });
    console.log("OK");
    return { label, status: "verified" };
  } catch (err) {
    const msg = err.message || "";
    if (
      msg.includes("Already Verified") ||
      msg.includes("already verified") ||
      msg.includes("Contract source code already verified")
    ) {
      console.log("already verified");
      return { label, status: "already_verified" };
    }
    console.log(`FAILED — ${msg.split("\n")[0]}`);
    return { label, status: "failed", error: msg };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const NET = network.name.toUpperCase();
  const lzEndpoint = LZ_ENDPOINTS[network.name];
  const admin = WALLETS.admin;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Verifying contracts on ${network.name}`);
  console.log(`${"─".repeat(60)}\n`);

  const results = [];

  // ── Step 1: SRXToken ─────────────────────────────────────────────────────
  //   constructor(address _lzEndpoint, address _admin)

  const srxTokenAddr = envOpt(`SRX_TOKEN_${NET}`);
  results.push(await verify(
    "SRXToken",
    srxTokenAddr,
    [lzEndpoint, admin]
  ));

  // ── Step 2: Governance ───────────────────────────────────────────────────
  //   SRXTimelock constructor(uint256 minDelay, address[] proposers, address[] executors, address admin)
  //   SRXGovernor constructor(IVotes token, TimelockController timelock)

  const timelockAddr = envOpt(`TIMELOCK_${NET}`);
  results.push(await verify(
    "SRXTimelock",
    timelockAddr,
    [
      GOVERNANCE.timelockDelayFor(network.name),
      [],                       // proposers — governor wired post-deploy
      [ethers.ZeroAddress],     // executors — open execution
      admin,
    ]
  ));

  const governorAddr = envOpt(`GOVERNOR_${NET}`);
  results.push(await verify(
    "SRXGovernor",
    governorAddr,
    [srxTokenAddr, timelockAddr]
  ));

  // ── Step 3: Vesting Vaults + TGEDistributor ──────────────────────────────
  //   VestingVault constructor(token, beneficiary, admin, cliffDuration, vestingDuration, tgeUnlockBps)

  const foundersVaultAddr  = envOpt(`VESTING_FOUNDERS_${NET}`);
  const coreTeamVaultAddr  = envOpt(`VESTING_CORE_TEAM_${NET}`);
  const seedVaultAddr      = envOpt(`VESTING_SEED_${NET}`);
  const presaleVaultAddr   = envOpt(`VESTING_PRESALE_${NET}`);
  const ecosystemVaultAddr = envOpt(`VESTING_ECOSYSTEM_${NET}`);

  results.push(await verify(
    "VestingVault (Founders)",
    foundersVaultAddr,
    [
      srxTokenAddr,
      WALLETS.founders,
      admin,
      VESTING.founders.cliffDuration,
      VESTING.founders.vestingDuration,
      VESTING.founders.tgeUnlockBps,
    ]
  ));

  results.push(await verify(
    "VestingVault (Core Team)",
    coreTeamVaultAddr,
    [
      srxTokenAddr,
      WALLETS.coreTeam,
      admin,
      VESTING.coreTeam.cliffDuration,
      VESTING.coreTeam.vestingDuration,
      VESTING.coreTeam.tgeUnlockBps,
    ]
  ));

  results.push(await verify(
    "VestingVault (Seed Investors)",
    seedVaultAddr,
    [
      srxTokenAddr,
      WALLETS.seedInvestors,
      admin,
      VESTING.seedInvestors.cliffDuration,
      VESTING.seedInvestors.vestingDuration,
      VESTING.seedInvestors.tgeUnlockBps,
    ]
  ));

  results.push(await verify(
    "VestingVault (Presale)",
    presaleVaultAddr,
    [
      srxTokenAddr,
      WALLETS.presale,
      admin,
      VESTING.presale.cliffDuration,
      VESTING.presale.vestingDuration,
      VESTING.presale.tgeUnlockBps,
    ]
  ));

  results.push(await verify(
    "VestingVault (Ecosystem DAO)",
    ecosystemVaultAddr,
    [
      srxTokenAddr,
      WALLETS.ecosystem,
      admin,
      VESTING.ecosystem.cliffDuration,
      VESTING.ecosystem.vestingDuration,
      VESTING.ecosystem.tgeUnlockBps,
    ]
  ));

  const tgeDistributorAddr = envOpt(`TGE_DISTRIBUTOR_${NET}`);
  results.push(await verify(
    "TGEDistributor",
    tgeDistributorAddr,
    [srxTokenAddr, admin]
  ));

  // ── Steps 4 + 5: UUPS proxy implementations ──────────────────────────────
  //   Verify the implementation contracts (no constructor args).
  //   The ERC1967 proxy itself is linked on the explorer via "Is this a proxy?".

  const stakingProxyAddr   = envOpt(`STAKING_${NET}`);
  const feeProxyAddr       = envOpt(`FEE_CONTROLLER_${NET}`);
  const treasuryProxyAddr  = envOpt(`TREASURY_${NET}`);

  // SRXStaking implementation
  if (stakingProxyAddr) {
    const stakingImplAddr = await readImplAddress(stakingProxyAddr);
    results.push(await verify("SRXStaking (implementation)", stakingImplAddr, []));
  } else {
    results.push({ label: "SRXStaking (implementation)", status: "skipped" });
    console.log(`  [SKIP]  SRXStaking — STAKING_${NET} not set`);
  }

  // FeeController implementation
  if (feeProxyAddr) {
    const feeImplAddr = await readImplAddress(feeProxyAddr);
    results.push(await verify("FeeController (implementation)", feeImplAddr, []));
  } else {
    results.push({ label: "FeeController (implementation)", status: "skipped" });
    console.log(`  [SKIP]  FeeController — FEE_CONTROLLER_${NET} not set`);
  }

  // SRXTreasury implementation
  if (treasuryProxyAddr) {
    const treasuryImplAddr = await readImplAddress(treasuryProxyAddr);
    results.push(await verify("SRXTreasury (implementation)", treasuryImplAddr, []));
  } else {
    results.push({ label: "SRXTreasury (implementation)", status: "skipped" });
    console.log(`  [SKIP]  SRXTreasury — TREASURY_${NET} not set`);
  }

  // StabilisationFund implementation (Step 5b)
  const ssfProxyAddr = envOpt(`STABILISATION_FUND_${NET}`);
  if (ssfProxyAddr) {
    const ssfImplAddr = await readImplAddress(ssfProxyAddr);
    results.push(await verify("StabilisationFund (implementation)", ssfImplAddr, []));
  } else {
    results.push({ label: "StabilisationFund (implementation)", status: "skipped" });
    console.log(`  [SKIP]  StabilisationFund — STABILISATION_FUND_${NET} not set`);
  }

  // ── Step 7: Bridge (SRXOFTNative on remote chains only) ──────────────────
  //   constructor(address _lzEndpoint, address _admin)
  //   Not deployed on origin chain (Ethereum / Sepolia).

  const isOriginChain = network.name === "sepolia" || network.name === "ethereum";
  const oftNativeAddr = envOpt(`SRX_OFT_NATIVE_${NET}`);

  if (!isOriginChain) {
    results.push(await verify(
      "SRXOFTNative",
      oftNativeAddr,
      [lzEndpoint, admin]
    ));
  }

  // ── Step 8: GuardianModule ───────────────────────────────────────────────
  //   constructor(address _admin, address _guardian, address _governance, uint256 _maxSunset)

  const guardianAddr       = envOpt(`GUARDIAN_${NET}`);
  const guardianMultisig   = process.env.GUARDIAN_MULTISIG || admin;
  const sunsetDays         = parseInt(process.env.GUARDIAN_SUNSET_DAYS || "180", 10);
  const sunsetSeconds      = sunsetDays * 86400;

  results.push(await verify(
    "GuardianModule",
    guardianAddr,
    [admin, guardianMultisig, timelockAddr, sunsetSeconds]
  ));

  // ── Step 9: ZkSyncMigrator ───────────────────────────────────────────────
  //   constructor(address _token, address _admin)

  const migratorAddr = envOpt(`MIGRATOR_${NET}`);
  results.push(await verify(
    "ZkSyncMigrator",
    migratorAddr,
    [srxTokenAddr, admin]
  ));

  // ── Summary ──────────────────────────────────────────────────────────────

  const verified        = results.filter((r) => r.status === "verified");
  const alreadyVerified = results.filter((r) => r.status === "already_verified");
  const skipped         = results.filter((r) => r.status === "skipped");
  const failed          = results.filter((r) => r.status === "failed");

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Verification summary — ${network.name}`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  Verified:         ${verified.length}`);
  console.log(`  Already verified: ${alreadyVerified.length}`);
  console.log(`  Skipped:          ${skipped.length}`);
  console.log(`  Failed:           ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\n  Failures:`);
    for (const r of failed) {
      console.log(`    - ${r.label}: ${r.error.split("\n")[0]}`);
    }
  }

  // Proxy linking reminder — only relevant for contracts that were verified
  const proxyContracts = [
    { label: "SRXStaking proxy",          addr: stakingProxyAddr },
    { label: "FeeController proxy",       addr: feeProxyAddr },
    { label: "SRXTreasury proxy",         addr: treasuryProxyAddr },
    { label: "StabilisationFund proxy",   addr: ssfProxyAddr },
  ].filter((p) => p.addr);

  if (proxyContracts.length > 0) {
    console.log(`\n  Proxy contracts — link implementations on the explorer:`);
    console.log(`  Open each proxy address on the explorer and click "Is this a proxy?"`);
    for (const p of proxyContracts) {
      console.log(`    ${p.label}: ${p.addr}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
