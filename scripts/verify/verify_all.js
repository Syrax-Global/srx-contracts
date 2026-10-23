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
 * Notes on SRXStaking, FeeController, SRXTreasury and StabilisationFund:
 *   Since REG-53 no SRX contract is upgradeable. These four are plain contracts
 *   deployed once by their constructor, so each is verified at its own address
 *   with its constructor arguments. There is no proxy and no implementation to link.
 *
 * If a contract is already verified the error is caught and the script
 * continues. All failures are collected and printed at the end.
 */

const { ethers, network, run } = require("hardhat");
const { LZ_ENDPOINTS, LZ_EIDS, WALLETS, VESTING, GOVERNANCE, TGE_PLAN, TESTNET_CHAINS, SSF, ssfRewardAllocation } = require("../deploy/00_config");

// ── Helpers ────────────────────────────────────────────────────────────────────

function envOpt(key) {
  return process.env[key] || null;
}

function envReq(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
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

  // One vault per "vault" row of TGE_PLAN (00_config.js), so a new bucket is
  // verified without anyone remembering to add it here.
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    const v = VESTING[row.schedule];
    results.push(await verify(
      `VestingVault (${row.label})`,
      envOpt(`${row.vaultEnv}_${NET}`),
      [srxTokenAddr, WALLETS[row.beneficiary], admin, v.cliffDuration, v.vestingDuration, v.tgeUnlockBps]
    ));
  }

  const tgeDistributorAddr = envOpt(`TGE_DISTRIBUTOR_${NET}`);
  results.push(await verify(
    "TGEDistributor",
    tgeDistributorAddr,
    [srxTokenAddr, admin]
  ));

  // ── Steps 4 + 5: SRXStaking, FeeController, SRXTreasury, StabilisationFund ──
  //   Plain contracts (REG-53): each is verified at its own address with the constructor
  //   arguments its deploy script used.
  //     SRXStaking          constructor(address _srx, address _admin, address _tgeDistributor)      (04)
  //     FeeController       constructor(address _stakingContract, address _admin)                   (04)
  //     SRXTreasury         constructor(address _srxToken, address _admin, address _timelock)       (05)
  //     StabilisationFund   constructor(srx, admin, maxDeployerBps, maxGuardianBps,
  //                                     withdrawLockDuration, rewardAllocation, tgeDistributor)     (05b)

  const stakingAddr   = envOpt(`STAKING_${NET}`);
  const feeAddr       = envOpt(`FEE_CONTROLLER_${NET}`);
  const treasuryAddr  = envOpt(`TREASURY_${NET}`);
  const ssfAddr       = envOpt(`STABILISATION_FUND_${NET}`);

  results.push(await verify("SRXStaking", stakingAddr, [srxTokenAddr, admin, tgeDistributorAddr]));
  results.push(await verify("FeeController", feeAddr, [stakingAddr, admin]));
  results.push(await verify("SRXTreasury", treasuryAddr, [srxTokenAddr, admin, timelockAddr]));

  // The fund's reward allocation is fixed for good (REG-50) and, on mainnet, undecided until
  // 00_config.js records it; verification cannot guess it.
  let ssfRewardAlloc = null;
  try { ssfRewardAlloc = ssfRewardAllocation(network.name); } catch (e) { console.log(`  [SKIP]  StabilisationFund — ${e.message.split(String.fromCharCode(10))[0]}`); }
  if (ssfAddr && ssfRewardAlloc === null) {
    results.push({ label: "StabilisationFund", status: "skipped" });
  } else {
    results.push(await verify(
      "StabilisationFund",
      ssfAddr,
      [srxTokenAddr, admin, SSF.MAX_DEPLOYER_BPS, SSF.MAX_GUARDIAN_BPS, SSF.WITHDRAW_LOCK_DURATION, ssfRewardAlloc, tgeDistributorAddr]
    ));
  }

  // ── Step 7: Bridge (SRXOFTNative on remote chains only) ──────────────────
  //   constructor(address _lzEndpoint, address _admin, uint32 _hubEid, address _hub)
  //   Not deployed on origin chain (Ethereum / Sepolia). The spoke Timelock beside it is
  //   SRXTimelock(delay, [Safe], [0x0], 0x0) (07 step A, SPOKE-01).

  const isOriginChain = network.name === "sepolia" || network.name === "ethereum";
  const oftNativeAddr = envOpt(`SRX_OFT_NATIVE_${NET}`);

  if (!isOriginChain) {
    results.push(await verify(
      "SRXOFTNative",
      oftNativeAddr,
      [lzEndpoint, admin,
       TESTNET_CHAINS.has(network.name) ? LZ_EIDS.sepolia : LZ_EIDS.ethereum,
       envOpt(TESTNET_CHAINS.has(network.name) ? "SRX_TOKEN_SEPOLIA" : "SRX_TOKEN_ETHEREUM")]
    ));
    results.push(await verify(
      "SRXTimelock (spoke)",
      envOpt(`SPOKE_TIMELOCK_${NET}`),
      [GOVERNANCE.timelockDelayFor(network.name), [admin], ["0x0000000000000000000000000000000000000000"], "0x0000000000000000000000000000000000000000"]
    ));
  }

  // ── Step 8: GuardianModule ───────────────────────────────────────────────
  //   constructor(address _admin, address _guardian, address _governance, uint256 _maxSunset)

  const guardianAddr       = envOpt(`GUARDIAN_MODULE_${NET}`) || envOpt(`GUARDIAN_${NET}`); // 08 prints GUARDIAN_MODULE_<NET>; the older name is still read (E-08)
  const guardianMultisig   = process.env.PAUSE_GUARDIAN || admin; // GuardianModule's guardian, as 08 deployed it (GUARDIAN_MULTISIG is retired, E-06)
  const sunsetDays         = parseInt(process.env.GUARDIAN_SUNSET_DAYS || "180", 10);
  const sunsetSeconds      = sunsetDays * 86400;

  results.push(await verify(
    "GuardianModule",
    guardianAddr,
    [admin, guardianMultisig, timelockAddr, sunsetSeconds]
  ));

  // ── Step 9: ZkSyncMigrator ───────────────────────────────────────────────
  //   constructor(address _token, address _admin)

  // Retired by CH-13 (22 Oct 2026); verified only where an old testnet deployment exists.
  const migratorAddr = envOpt(`MIGRATOR_${NET}`);
  if (migratorAddr && migratorAddr.toLowerCase() !== "none") {
    results.push(await verify("ZkSyncMigrator", migratorAddr, [srxTokenAddr, admin]));
  }

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

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
