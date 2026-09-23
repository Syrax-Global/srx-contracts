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
 * ⛔ SC-TRUST-002 (finding DEP-01): setAllocations(), genesis(), distribute() and
 *    triggerTGE() are all gated by an admin field that is the configured admin
 *    address (00_config.js) — the admin Gnosis Safe on mainnet, never the deployer
 *    EOA. They now route through scripts/deploy/lib/adminTx.js. When the loaded
 *    signer IS the admin (testnets)
 *    every step still executes immediately, in order, exactly as before. When it
 *    is NOT (mainnet), those four groups of calls are queued into ONE Safe batch —
 *    safe, because none of their calldata depends on a read that only becomes
 *    correct after an earlier call in the batch executes (triggerTGE() takes no
 *    args and reads its own balance on-chain at execution time; a Safe batch runs
 *    atomically and in order). The script then flushes and STOPS: it does not
 *    attempt step 4 (registering the staking incentive pool) in that same run,
 *    because notifyRewardAmount(amount) needs the ACTUAL post-distribution staking
 *    balance as an argument, and that balance does not exist yet — it is what the
 *    queued batch is about to create. Re-run this script after the admin Safe
 *    executes the batch: the pre-flight checks below detect what is already done
 *    and skip it, then step 4 runs with the real balance.
 *
 * Run: npx hardhat run scripts/deploy/06_execute_tge.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const readline = require("readline");
const { ALLOCATIONS } = require("./00_config");
const { runTgeTargetChecks } = require("./lib/tge_targets");
const { createAdminBatch } = require("./lib/adminTx");

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
  //
  // ⭐ These no longer abort when a step is already done — they report status,
  //    so the script is safely re-runnable after the admin Safe executes a
  //    queued batch (see the header note on SC-TRUST-002 / adminTx routing).

  console.log("\n--- Pre-flight checks ---");

  const genesisDone = await token.genesisComplete();
  console.log(`${genesisDone ? "  ✓ (already done)" : "✅"} Genesis ${genesisDone ? "already executed" : "not yet executed"}`);

  const distributedDone = await tge.distributed();
  console.log(`${distributedDone ? "  ✓ (already done)" : "✅"} Distribution ${distributedDone ? "already executed" : "not yet executed"}`);

  // Verify StabilisationFund contract exists at the given address
  const ssfCode = await ethers.provider.getCode(ssfAddr);
  if (ssfCode === "0x") throw new Error(`StabilisationFund not deployed at ${ssfAddr}. Run Step 5b first.`);
  console.log(`✅ StabilisationFund deployed at ${ssfAddr}`);

  const maxSupply = await token.MAX_SUPPLY();
  console.log(`✅ MAX_SUPPLY: ${ethers.formatUnits(maxSupply, 18)} SRX`);

  // Check each vault's trigger state (informational — used below to skip
  // already-triggered vaults rather than to abort).
  const vaultTriggered = {};
  for (const [label, addr] of Object.entries(vaultAddresses)) {
    const vault = await ethers.getContractAt("VestingVault", addr);
    const triggered = await vault.tgeTriggered();
    vaultTriggered[label] = triggered;
    console.log(`${triggered ? "  ✓ (already done)" : "✅"} ${label} vault (${addr}) — TGE ${triggered ? "already triggered" : "not yet triggered"}`);
  }
  const allVaultsTriggered = Object.values(vaultTriggered).every(Boolean);
  const phaseADone = genesisDone && distributedDone && allVaultsTriggered;

  // ── Confirmation ─────────────────────────────────────────────────────────

  if (!phaseADone && network.name !== "hardhat" && network.name !== "localhost") {
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

  const batch = createAdminBatch("06_tge");
  const adminExecuting = await batch.isAdmin();

  if (!phaseADone) {
    // ── Step 0: setAllocations() — route strategic reserve to SSF ──────────
    //
    // TGEDistributor.setAllocations() is idempotent before distribution.
    // We call it here (just before genesis) to ensure the final allocation
    // table is correct regardless of what was set in Step 3. finalAllocations
    // is the list the destination controls above checked — not a second copy.

    if (!distributedDone) {
      console.log(`\n[0/4] Configuring TGEDistributor allocations (strategic → SSF)...`);
      await batch.send(tge, "setAllocations", [finalAllocations], `TGEDistributor.setAllocations(...) — strategic reserve → StabilisationFund (${ssfAddr})`);
    } else {
      console.log(`\n[0/4] Skipping — distribution already executed.`);
    }

    // ── Step 1: genesis() ────────────────────────────────────────────────

    if (!genesisDone) {
      console.log(`\n[1/4] Calling SRXToken.genesis(${tgeAddr})...`);
      await batch.send(token, "genesis", [tgeAddr], `SRXToken.genesis(${tgeAddr})`);
      if (adminExecuting) {
        const distributorBal = await token.balanceOf(tgeAddr);
        console.log(`   TGEDistributor balance: ${ethers.formatUnits(distributorBal, 18)} SRX`);
        if (distributorBal !== maxSupply) {
          throw new Error(`Distributor balance mismatch! Expected ${maxSupply}, got ${distributorBal}`);
        }
      }
    } else {
      console.log(`\n[1/4] Skipping — genesis already executed.`);
    }

    // ── Step 2: distribute() ────────────────────────────────────────────

    if (!distributedDone) {
      console.log(`\n[2/4] Calling TGEDistributor.distribute()...`);
      await batch.send(tge, "distribute", [], "TGEDistributor.distribute()");
      if (adminExecuting) {
        const afterBal = await token.balanceOf(tgeAddr);
        console.log(`   TGEDistributor balance after: ${ethers.formatUnits(afterBal, 18)} SRX (expected 0)`);
        if (afterBal !== 0n) {
          throw new Error(`Distributor not empty after distribution! Remaining: ${afterBal}`);
        }
      }
    } else {
      console.log(`\n[2/4] Skipping — already distributed.`);
    }

    // ── Step 3: triggerTGE() on each vesting vault ──────────────────────

    console.log(`\n[3/4] Triggering TGE on all vesting vaults...`);

    for (const [label, addr] of Object.entries(vaultAddresses)) {
      if (vaultTriggered[label]) {
        console.log(`  ✓ ${label} — already triggered`);
        continue;
      }
      const vault = await ethers.getContractAt("VestingVault", addr);

      if (adminExecuting) {
        const bal = await token.balanceOf(addr);
        console.log(`  ${label}: balance=${ethers.formatUnits(bal, 18)} SRX`);
        if (bal === 0n) console.warn(`  ⚠️  ${label} vault has 0 balance — check allocations`);
      }

      await batch.send(vault, "triggerTGE", [], `VestingVault(${label}).triggerTGE()`);

      if (adminExecuting) {
        const ts = await vault.tgeTimestamp();
        console.log(`  ✅ ${label} TGE triggered — timestamp ${new Date(Number(ts) * 1000).toISOString()}`);
      }
    }

    const wrote = await batch.flush();
    if (wrote) {
      console.log(`\n⛔ Signer is not the admin Safe. Allocations/genesis/distribute/vesting-triggers above`);
      console.log(`   are QUEUED, not executed — reading balances now would read stale state, so this run`);
      console.log(`   stops here rather than guess. The admin Safe must execute ${wrote}`);
      console.log(`   first. Re-run this script afterward to verify it landed and finish step 4/4`);
      console.log(`   (registering the staking incentive pool), which needs the real post-distribution balance.`);
      return;
    }
    // Nothing queued: either adminExecuting ran every step above directly just
    // now, or phase A had nothing left to do. Either way on-chain state now
    // reflects genesis + distribution + every vault trigger, so continuing is safe.
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
      await batch.send(staking, "notifyRewardAmount", [registerAmount], `SRXStaking.notifyRewardAmount(${ethers.formatUnits(registerAmount, 18)} SRX)`);
      if (adminExecuting) {
        console.log(`  Pool balance: ${ethers.formatUnits(await staking.rewardPool(), 18)} SRX`);
      }
    } else {
      console.warn(`  ⚠️  Staking contract has 0 balance — check TGE distribution.`);
    }
  }

  const finalWrote = await batch.flush();
  if (finalWrote) {
    console.log(`\n📝 Staking incentive pool registration queued for the admin Safe: ${finalWrote}`);
    console.log(`   TGE is NOT complete until the Safe executes it. Re-run this script afterwards to confirm.`);
    return;
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
