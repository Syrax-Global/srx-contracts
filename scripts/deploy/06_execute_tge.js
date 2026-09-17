/**
 * Step 6 — Execute TGE (Genesis + Distribute + Trigger Vesting Clocks)
 *
 * This is the most critical step in the entire deployment sequence.
 * It performs four operations in order:
 *
 *  1. SRXToken.genesis(tgeDistributor)  — mints 10 billion SRX to the distributor.
 *  2. TGEDistributor.distribute()       — sends each allocation to its destination.
 *  3. VestingVault.triggerTGE()         — starts the vesting clock on each vault.
 *  4. SRXStaking.notifyRewardAmount()   — registers the 1.7B staking allocation
 *                                         as the ecosystem participation incentive pool.
 *
 * Steps 1–3 are irreversible. Step 4 is accountingonly (tokens already arrived in
 * the staking contract via step 2). Incentive emissions don't start until governance
 * separately calls staking.setRewardRate() — step 4 just arms the pool.
 *
 * ⚠️  THIS IS A ONE-WAY OPERATION. Once called, it CANNOT be undone.
 *
 * Pre-flight checklist — verify EVERY item before running:
 *  [ ] All vesting vaults deployed and verified on block explorer
 *  [ ] TGEDistributor deployed (setAllocations will be called fresh by this script)
 *  [ ] Treasury contract deployed (TREASURY_<NETWORK> set in .env)
 *  [ ] StabilisationFund deployed (STABILISATION_FUND_<NETWORK> set in .env) ← Step 5b
 *  [ ] Staking contract deployed (STAKING_<NETWORK> set in .env)
 *  [ ] SRXToken genesisComplete == false
 *  [ ] TGEDistributor distributed == false
 *  [ ] deploy/addresses.<network>.json written from the signed-off records
 *      (every destination, every vault beneficiary, every role) — the script
 *      REFUSES to run without it on any network other than hardhat/localhost
 *  [ ] Admin wallet has sufficient ETH for gas
 *
 * ⭐ The destination checks are no longer a separate command to remember: this
 *    script runs them itself (scripts/deploy/lib/tge_targets.js) before any
 *    transaction, stops on any failure, and then sends EXACTLY the list it
 *    checked. Allocation sum, destinations, manifest match, role holders, and each
 *    vault's token, beneficiary and schedule are all covered there.
 *
 * Run: npx hardhat run scripts/deploy/06_execute_tge.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const readline = require("readline");
const { ALLOCATIONS } = require("./00_config");
const { runTgeTargetChecks } = require("./lib/tge_targets");

// Only the getters the destination controls read. Kept inline so the check does
// not depend on compiled artifacts matching the deployed vault.
const VAULT_ABI = [
  "function token() view returns (address)",
  "function beneficiary() view returns (address)",
  "function cliffDuration() view returns (uint256)",
  "function vestingDuration() view returns (uint256)",
  "function tgeUnlockBps() view returns (uint256)",
];

function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${question} [yes/no]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "yes");
    });
  });
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET = network.name.toUpperCase();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  TGE EXECUTION — ${NET}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Signer: ${deployer.address}\n`);

  // ── Load addresses ───────────────────────────────────────────────────────

  const srxTokenAddr  = env(`SRX_TOKEN_${NET}`);
  const tgeAddr       = env(`TGE_DISTRIBUTOR_${NET}`);
  const token = await ethers.getContractAt("SRXToken", srxTokenAddr);
  const tge   = await ethers.getContractAt("TGEDistributor", tgeAddr);

  // ── Destination controls — BEFORE anything else, and fatal ───────────────
  //
  // ⛔ This used to be a separate script (verify_tge_targets.js) that nothing
  //    here called. It is now the first thing that runs, and finalAllocations
  //    below IS the list it checked.

  console.log("--- Destination controls ---");
  const { chainId } = await ethers.provider.getNetwork();
  const gate = await runTgeTargetChecks({
    networkName: network.name,
    chainId,
    provider: ethers.provider,
    vaultAt: (addr) => new ethers.Contract(addr, VAULT_ABI, ethers.provider),
    tokenAddress: srxTokenAddr,
  });
  if (gate.skipped) {
    console.warn(`⚠️  No manifest at ${gate.manifestPath} — allowed only on ${network.name}.`);
  }
  if (gate.failures.length > 0) {
    for (const f of gate.failures) console.error(`❌ ${f}`);
    throw new Error(`${gate.failures.length} destination check(s) failed — TGE NOT executed. Nothing was sent.`);
  }
  const finalAllocations = gate.allocations;
  for (const a of finalAllocations) {
    console.log(`✅ ${a.label.padEnd(18)} ${a.destination}  ${ethers.formatUnits(a.amount, 18)} SRX`);
  }
  const byLabel     = Object.fromEntries(finalAllocations.map((a) => [a.label, a.destination]));
  const stakingAddr = byLabel.Staking;
  const ssfAddr     = byLabel.StabilisationFund;

  // Vesting vault addresses — needed for step 3 (triggerTGE)
  const vaultAddresses = Object.fromEntries(
    finalAllocations.filter((a) => a.isVestingVault).map((a) => [a.label, a.destination])
  );

  // ── Pre-flight checks ────────────────────────────────────────────────────

  console.log("\n--- Pre-flight checks ---");

  if (await token.genesisComplete()) throw new Error("Genesis already complete. Aborting.");
  console.log("✅ Genesis not yet executed");

  if (await tge.distributed()) throw new Error("TGE already distributed. Aborting.");
  console.log("✅ Distribution not yet executed");

  // Verify StabilisationFund contract exists at the given address
  const ssfCode = await ethers.provider.getCode(ssfAddr);
  if (ssfCode === "0x") throw new Error(`StabilisationFund not deployed at ${ssfAddr}. Run Step 5b first.`);
  console.log(`✅ StabilisationFund deployed at ${ssfAddr}`);

  const maxSupply = await token.MAX_SUPPLY();
  console.log(`✅ MAX_SUPPLY: ${ethers.formatUnits(maxSupply, 18)} SRX`);

  // Verify each vault is accessible and not yet triggered
  for (const [label, addr] of Object.entries(vaultAddresses)) {
    const vault = await ethers.getContractAt("VestingVault", addr);
    const triggered = await vault.tgeTriggered();
    if (triggered) throw new Error(`${label} vault TGE already triggered. Aborting.`);
    console.log(`✅ ${label} vault (${addr}) — TGE not yet triggered`);
  }

  // ── Confirmation ─────────────────────────────────────────────────────────

  if (network.name !== "hardhat" && network.name !== "localhost") {
    const ok = await confirm(
      `⚠️  You are about to execute TGE on ${network.name}.\n` +
      `   This mints 10,000,000,000 SRX and starts all vesting clocks.\n` +
      `   THIS IS IRREVERSIBLE. Confirm?`
    );
    if (!ok) {
      console.log("Aborted by user.");
      return;
    }
  }

  // ── Step 0: setAllocations() — route strategic reserve to SSF ────────────
  //
  // TGEDistributor.setAllocations() is idempotent before distribution.
  // We call it here (just before genesis) to ensure the final allocation
  // table is correct regardless of what was set in Step 3. finalAllocations is
  // the list the destination controls above checked — not a second copy of it.

  console.log(`\n[0/4] Configuring TGEDistributor allocations (strategic → SSF)...`);

  const allocTx = await tge.setAllocations(finalAllocations);
  await allocTx.wait();
  console.log(`✅ Allocations set — strategic reserve → StabilisationFund (${ssfAddr})`);

  // ── Step 1: genesis() ────────────────────────────────────────────────────

  console.log(`\n[1/4] Calling SRXToken.genesis(${tgeAddr})...`);
  const genesisTx      = await token.genesis(tgeAddr);
  const genesisReceipt = await genesisTx.wait();
  const distributorBal = await token.balanceOf(tgeAddr);

  console.log(`✅ Genesis executed — block ${genesisReceipt.blockNumber}`);
  console.log(`   TGEDistributor balance: ${ethers.formatUnits(distributorBal, 18)} SRX`);

  if (distributorBal !== maxSupply) {
    throw new Error(`Distributor balance mismatch! Expected ${maxSupply}, got ${distributorBal}`);
  }

  // ── Step 2: distribute() ─────────────────────────────────────────────────

  console.log(`\n[2/4] Calling TGEDistributor.distribute()...`);
  const distTx      = await tge.distribute();
  const distReceipt = await distTx.wait();
  const afterBal    = await token.balanceOf(tgeAddr);

  console.log(`✅ Distribution complete — block ${distReceipt.blockNumber}`);
  console.log(`   TGEDistributor balance after: ${ethers.formatUnits(afterBal, 18)} SRX (expected 0)`);

  if (afterBal !== 0n) {
    throw new Error(`Distributor not empty after distribution! Remaining: ${afterBal}`);
  }

  // ── Step 3: triggerTGE() on each vesting vault ───────────────────────────

  console.log(`\n[3/4] Triggering TGE on all vesting vaults...`);

  for (const [label, addr] of Object.entries(vaultAddresses)) {
    const vault  = await ethers.getContractAt("VestingVault", addr);
    const bal    = await token.balanceOf(addr);

    console.log(`  ${label}: balance=${ethers.formatUnits(bal, 18)} SRX`);
    if (bal === 0n) {
      console.warn(`  ⚠️  ${label} vault has 0 balance — check allocations`);
    }

    const tx      = await vault.triggerTGE();
    const receipt = await tx.wait();
    const ts      = await vault.tgeTimestamp();

    console.log(`  ✅ ${label} TGE triggered — block ${receipt.blockNumber}, timestamp ${new Date(Number(ts) * 1000).toISOString()}`);
  }

  // ── Step 4: Register staking allocation as incentive pool ───────────────

  console.log(`\n[4/4] Registering staking allocation as ecosystem incentive pool...`);

  // STAKING_<NET> is required by the destination controls, so there is no
  // "staking address unset" branch any more.
  {
    const staking     = await ethers.getContractAt("SRXStaking", stakingAddr);
    const stakingBal  = await token.balanceOf(stakingAddr);
    console.log(`  Staking contract balance: ${ethers.formatUnits(stakingBal, 18)} SRX`);

    if (stakingBal < ALLOCATIONS.staking) {
      console.warn(`  ⚠️  Balance (${ethers.formatUnits(stakingBal, 18)}) < expected allocation (${ethers.formatUnits(ALLOCATIONS.staking, 18)}). Proceeding with actual balance.`);
    }

    const registerAmount = stakingBal > 0n ? stakingBal : 0n;
    if (registerAmount > 0n) {
      const tx      = await staking.notifyRewardAmount(registerAmount);
      const receipt = await tx.wait();
      console.log(`  ✅ Incentive pool registered — ${ethers.formatUnits(registerAmount, 18)} SRX (block ${receipt.blockNumber})`);
      console.log(`  Pool balance: ${ethers.formatUnits(await staking.rewardPool(), 18)} SRX`);
    } else {
      console.warn(`  ⚠️  Staking contract has 0 balance — check TGE distribution.`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ✅ TGE EXECUTED SUCCESSFULLY`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Total supply:  ${ethers.formatUnits(await token.totalSupply(), 18)} SRX`);
  console.log(`  Total burned:  ${ethers.formatUnits(await token.totalBurned(), 18)} SRX`);
  console.log(`\n  Next steps:`);
  console.log(`    [ ] Verify all vault balances on block explorer`);
  console.log(`    [ ] Verify each vault's tgeTimestamp matches expected TGE date`);
  console.log(`    [ ] Set incentive emission rate via governance:`);
  console.log(`          staking.setRewardRate(13_500_000_000_000_000_000)  // ~4yr distribution`);
  console.log(`    [ ] Announce TGE to community with vault addresses for transparency`);
  console.log(`    [ ] Verify StabilisationFund received 1,500,000,000 SRX:`);
  console.log(`          npx hardhat console --network ${network.name}`);
  console.log(`          > (await ethers.getContractAt("StabilisationFund","${ssfAddr}")).srxBalance()`);
  console.log(`    [ ] Deploy GuardianModule (Step 8) if not yet done — wires PAUSER_ROLE on SSF`);
  console.log(`    [ ] Deploy ZkSyncMigrator (Step 9) when Syrax Chain is ready`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
