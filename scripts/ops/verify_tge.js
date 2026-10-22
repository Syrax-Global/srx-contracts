/**
 * Post-TGE verification script.
 *
 * Run after 06_execute_tge.js to confirm all allocations landed correctly.
 *
 * Run: npx hardhat run scripts/ops/verify_tge.js --network sepolia
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();
const { ALLOCATIONS, VESTING, TGE_PLAN, walletFor, launchFloat } = require("../deploy/00_config");
const { launchPlan, readGenesisSold } = require("../deploy/lib/genesis_seed");
const { walletCapConflicts, missingExemptions } = require("../deploy/lib/launch_checks");

function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key} — run the relevant deploy step first`);
  return val;
}

async function main() {
  const NET = network.name.toUpperCase();

  // Prefer _TGE-suffixed addresses (test stack) if present, fall back to standard
  const suffix = process.env[`SRX_TOKEN_${NET}_TGE`] ? `_TGE` : ``;

  const token   = await ethers.getContractAt("SRXToken",          env(`SRX_TOKEN_${NET}${suffix}`));
  const ssf     = await ethers.getContractAt("StabilisationFund", env(`STABILISATION_FUND_${NET}${suffix}`));
  const staking = await ethers.getContractAt("SRXStaking",        env(`STAKING_${NET}${suffix}`));
  const tge     = await ethers.getContractAt("TGEDistributor",    env(`TGE_DISTRIBUTOR_${NET}${suffix}`));

  // ⛔ The vault addresses were read as VAULT_* names, which only the test stack
  //    printed; 03_deploy_vesting.js prints VESTING_* names, so on a real deployment
  //    this script stopped at "Missing env var" before checking anything. Both now
  //    print, and this reads, the names in TGE_PLAN.
  const vaults = {};
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    vaults[row.label] = env(`${row.vaultEnv}_${NET}${suffix}`);
  }

  // The seed allocation is split between the seed vault and the Genesis round by what
  // the round sold (lib/genesis_seed.js); every amount below comes from this split.
  const genesis = await readGenesisSold({ networkName: network.name, provider: ethers.provider, tokenAddress: await token.getAddress() });
  const { plan, allocations: AMOUNTS } = launchPlan(genesis.sold);

  if (suffix) console.log(`ℹ️  Using TGE test stack addresses (${NET}_TGE)\n`);
  else        console.log(`ℹ️  Using standard ${NET} addresses\n`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  POST-TGE VERIFICATION — ${NET}`);
  console.log(`${"=".repeat(60)}\n`);

  // ⭐ EVERY check below records into this ledger, and the exit code is derived
  //    from it. Before this, the verdict gated on supplyOk && distributed &&
  //    genesisComplete ONLY — balOk, triggered, pctOk, cliffOk, poolOk and ssfOk
  //    were computed, printed with a ❌, and then excluded from the result. A
  //    wrong staking pool or a wrong SSF balance printed a cross and still
  //    reported TGE VERIFICATION PASSED.
  //
  // ⛔ And the process still exited 0 on failure: process.exit(1) lived only in
  //    the .catch() for a THROWN error, so a printed FAILED was invisible to any
  //    caller, CI job or runbook step that checks $?. A verification that cannot
  //    fail its own exit code is not a gate.
  const failures = [];
  const check = (ok, what) => { if (!ok) failures.push(what); return ok; };

  // ── Token state ─────────────────────────────────────────────────────────────
  const totalSupply = await token.totalSupply();
  const genesisComplete = await token.genesisComplete();
  const distributed = await tge.distributed();

  console.log("── Token ──────────────────────────────────────────────────");
  console.log(`Total supply:      ${ethers.formatUnits(totalSupply, 18)} SRX`);
  const supplyOk = check(totalSupply === ethers.parseUnits("10000000000", 18), "total supply != 10,000,000,000 SRX");
  console.log(`Supply correct:    ${supplyOk ? "✅" : "❌"} (expect 10,000,000,000 SRX)`);
  check(genesisComplete, "genesisComplete is false");
  check(distributed, "TGE distributed is false");
  console.log(`Genesis complete:  ${genesisComplete ? "✅" : "❌"} (expect true)`);
  console.log(`TGE distributed:   ${distributed ? "✅" : "❌"} (expect true)`);

  // ── Direct allocations ──────────────────────────────────────────────────────
  console.log("\n── Direct allocations ─────────────────────────────────────");

  // Every row that is not a vault, with its amount from 00_config.js — nothing typed here.
  const contractAddr = {
    Staking: env(`STAKING_${NET}${suffix}`),
    Treasury: env(`TREASURY_${NET}${suffix}`),
    StabilisationFund: await ssf.getAddress(),
  };
  // The Genesis contract is checked in its own section below: by now it has passed
  // everything it received into its buyers' vaults (06b_genesis_vaults.js).
  const checks = plan.filter((r) => r.kind !== "vault" && r.label !== "Genesis").map((row) => ({
    label: row.label,
    addr: row.kind === "wallet" ? walletFor(row.wallet, network.name) : contractAddr[row.label],
    expected: ethers.formatUnits(AMOUNTS[row.allocation], 18).replace(/\.0$/, ""),
  }));
  checks.push({ label: "TGEDistributor", addr: env(`TGE_DISTRIBUTOR_${NET}${suffix}`), expected: "0" });

  for (const { label, addr, expected } of checks) {
    const bal = await token.balanceOf(addr);
    const expectedWei = ethers.parseUnits(expected, 18);
    // ⛔ This result was printed and then left out of the verdict, so a wrong
    //    treasury balance, or tokens left in the distributor, still PASSED.
    const ok = check(bal === expectedWei, `${label} balance ${ethers.formatUnits(bal, 18)} SRX != ${expected}`);
    console.log(`  ${label.padEnd(20)}: ${ethers.formatUnits(bal, 18).padStart(16)} SRX  ${ok ? "✅" : "❌"} (expect ${expected})`);
  }

  // ── Vesting vaults ──────────────────────────────────────────────────────────
  console.log("\n── Vesting vaults ─────────────────────────────────────────");

  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    const label     = row.label;
    const addr      = vaults[label];
    const sched     = VESTING[row.schedule];
    const vault     = await ethers.getContractAt("VestingVault", addr);
    const bal       = await token.balanceOf(addr);
    const triggered = await vault.tgeTriggered();
    const expected  = AMOUNTS[row.allocation];
    const balOk     = bal === expected;
    const tsStr     = triggered
      ? new Date(Number(await vault.tgeTimestamp()) * 1000).toISOString().slice(0, 19) + "Z"
      : "NOT TRIGGERED";

    check(balOk,     `${label} vault balance mismatch`);
    check(triggered, `${label} vault not triggered`);
    console.log(`  ${label.padEnd(18)}: ${ethers.formatUnits(bal, 18).padStart(16)} SRX  ${balOk ? "✅" : "❌"}  triggered=${triggered ? "✅" : "❌"}  ${tsStr}`);

    // What may be released now: the TGE unlock, and nothing more until the cliff ends.
    if (triggered) {
      const releasableNow = await vault.releasable();
      const tgeTs   = await vault.tgeTimestamp();
      const now     = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const atTge   = (expected * sched.tgeUnlockBps) / 10_000n;
      if (now < tgeTs + sched.cliffDuration) {
        const ok = check(releasableNow === atTge, `${label} vault releasable ${ethers.formatUnits(releasableNow, 18)} before its cliff (expect ${ethers.formatUnits(atTge, 18)})`);
        const cliffEnd = new Date(Number(tgeTs + sched.cliffDuration) * 1000).toISOString().slice(0, 19) + "Z";
        console.log(`             releasable()=${ethers.formatUnits(releasableNow, 18)} SRX  (before cliff: ${ok ? "✅" : "❌"})  cliff ends ${cliffEnd}`);
      }
    }
  }

  // ── The Genesis round, funded from the seed allocation ──────────────────────
  // Every buyer's vault exists, runs on the seed schedule and holds what they are
  // owed; the Genesis contract itself holds nothing (anything it held could leave
  // unlocked through recoverSRX). Seed vault + buyers' vaults = the seed allocation.
  if (genesis.sold > 0n) {
    console.log("\n── Genesis round (funded from the seed allocation) ────────");
    const round = await ethers.getContractAt("PreSaleRound", genesis.address);
    const seed = VESTING.seedInvestors;
    let inVaults = 0n, count = 0;
    for (const investor of await round.getInvestorList()) {
      const addr = await round.getVault(investor);
      if (!check(addr !== ethers.ZeroAddress, `Genesis buyer ${investor} has no vault (run 06b_genesis_vaults.js)`)) continue;
      const vault = await ethers.getContractAt("VestingVault", addr);
      const [ben, cliff, vest, bps, started, bal, inv] = await Promise.all([
        vault.beneficiary(), vault.cliffDuration(), vault.vestingDuration(), vault.tgeUnlockBps(),
        vault.tgeTriggered(), token.balanceOf(addr), round.investors(investor),
      ]);
      check(ethers.getAddress(ben) === ethers.getAddress(investor), `Genesis vault ${addr} pays ${ben}, not ${investor}`);
      check(cliff === seed.cliffDuration && vest === seed.vestingDuration && bps === seed.tgeUnlockBps, `Genesis vault ${addr} is not on the seed schedule`);
      check(started, `Genesis vault ${addr} clock not started`);
      check(bal === inv.srxAllocation, `Genesis vault ${addr} holds ${ethers.formatUnits(bal, 18)} SRX, owed ${ethers.formatUnits(inv.srxAllocation, 18)}`);
      inVaults += bal; count++;
    }
    const left = await token.balanceOf(genesis.address);
    // Internal audit L6: what matters is that no buyer is still owed SRX here. A surplus
    // (anyone can send SRX) is recoverable and can no longer reach buyers' SRX.
    const leftOk = check((await round.pendingDeployment()) === 0n, `the Genesis contract still owes buyers ${ethers.formatUnits(await round.pendingDeployment(), 18)} SRX`);
    if (left !== 0n) console.log(`  ⚠️ ${ethers.formatUnits(left, 18)} SRX surplus in the Genesis contract (recoverable with recoverSRX)`);
    const soldOk = check(inVaults === genesis.sold, `Genesis vaults hold ${ethers.formatUnits(inVaults, 18)} SRX, the round sold ${ethers.formatUnits(genesis.sold, 18)}`);
    const seedOk = check(AMOUNTS.seedInvestors + inVaults === ALLOCATIONS.seedInvestors, "seed vault + Genesis vaults ≠ the seed allocation");
    console.log(`  ${count} buyers' vaults: ${ethers.formatUnits(inVaults, 18)} SRX  ${soldOk ? "✅" : "❌"} (sold ${ethers.formatUnits(genesis.sold, 18)})`);
    console.log(`  Owed to buyers without a vault: none  ${leftOk ? "✅" : "❌"}`);
    console.log(`  Seed vault + Genesis vaults = the seed allocation  ${seedOk ? "✅" : "❌"}`);
  }

  // ── The launch-day float ─────────────────────────────────────────────────────
  // Right after TGE, the liquid rows hold exactly the published float (5%).
  {
    const float = launchFloat(plan, AMOUNTS);
    let liquid = 0n;
    for (const row of plan.filter((r) => r.liquid)) liquid += await token.balanceOf(walletFor(row.wallet, network.name));
    const ok = check(liquid === float, `launch float ${ethers.formatUnits(liquid, 18)} SRX != ${ethers.formatUnits(float, 18)}`);
    console.log(`\n  Launch float (liquid rows): ${ethers.formatUnits(liquid, 18)} SRX  ${ok ? "✅" : "❌"} (expect ${ethers.formatUnits(float, 18)})`);
  }

  // ── Launch protection vs the vesting schedules ───────────────────────────────
  //
  // ⛔ THESE TWO CONTROLS CAN BE CONFIGURED INTO A DEADLOCK, AND NOTHING WARNED.
  //    maxWalletBalance caps the RECIPIENT of a transfer and does not consider the
  //    sender, so a vesting vault paying out is capped like any other transfer
  //    even though the vault itself is exempt. Set the cap below a vault's
  //    releasable amount and the beneficiary simply cannot claim -- release()
  //    reverts, indefinitely, and the first anyone hears of it is a founder
  //    reporting a failed transaction.
  //
  // ⚠️ It cannot be fixed by exempting the sender: the isExemptFromLimits note in SRXToken.sol REQUIRES
  //    DEX pool addresses to be exempt, so skipping the cap whenever the sender is
  //    exempt would let every purchase from the pool bypass it and would defeat
  //    launch protection entirely. The incompatibility is real, so it is checked
  //    here instead of being designed away.

  // ⭐ Checked against each beneficiary's WHOLE remaining entitlement, for the launch
  //    vaults and every Genesis buyer's vault (lib/launch_checks.js). Set
  //    PLANNED_MAX_WALLET (whole SRX) to check a cap BEFORE switching it on; re-run
  //    this after any setMaxWalletBalance.
  console.log("\n── Launch protection vs vesting ───────────────────────────");
  const onChainCap = await token.maxWalletBalance();
  const walletCap = process.env.PLANNED_MAX_WALLET ? ethers.parseUnits(process.env.PLANNED_MAX_WALLET, 18) : onChainCap;
  console.log(`  wallet cap checked: ${walletCap === 0n ? "none (0)" : ethers.formatUnits(walletCap, 18) + " SRX"}${process.env.PLANNED_MAX_WALLET ? " (planned)" : ""}`);
  const capVaults = [];
  const vaultAddrs = Object.entries(vaults).filter(([, a]) => a !== ethers.ZeroAddress);
  if (genesis.sold > 0n) {
    const round = await ethers.getContractAt("PreSaleRound", genesis.address);
    for (const inv of await round.getInvestorList()) {
      const a = await round.getVault(inv);
      if (a !== ethers.ZeroAddress) vaultAddrs.push([`Genesis ${inv.slice(0, 8)}`, a]);
    }
  }
  for (const [label, addr] of vaultAddrs) {
    const vault = await ethers.getContractAt("VestingVault", addr);
    const ben = await vault.beneficiary();
    capVaults.push({
      label, beneficiary: ben,
      exempt: await token.isExemptFromLimits(ben),
      beneficiaryBalance: await token.balanceOf(ben),
      initialAllocation: await vault.initialAllocation(),
      released: await vault.released(),
    });
  }
  const capFailures = walletCapConflicts({ cap: walletCap, vaults: capVaults });
  for (const f of capFailures) check(false, f);
  console.log(`  ${capVaults.length} vaults checked: ${capFailures.length === 0 ? "no beneficiary can be locked out ✅" : capFailures.length + " would be locked out ❌"}`);

  // Every contract that moves SRX for users must be exempt before protection is on
  // (staking exits, early-exit penalties to 0xdEaD, vault releases, the Genesis vaults…).
  const transferCap = process.env.PLANNED_MAX_TRANSFER ? ethers.parseUnits(process.env.PLANNED_MAX_TRANSFER, 18) : await token.maxTransferAmount();
  if (walletCap !== 0n || transferCap !== 0n) {
    const optional = (k) => { const v = process.env[`${k}_${NET}${suffix}`]; return v && v.toLowerCase() !== "none" ? v : null; };
    const required = [
      { label: "SRXToken itself", address: await token.getAddress() },
      { label: "SRXStaking", address: await staking.getAddress() },
      { label: "SRXTreasury", address: contractAddr.Treasury },
      { label: "StabilisationFund", address: await ssf.getAddress() },
      { label: "TGEDistributor", address: await tge.getAddress() },
      { label: "0xdEaD (early-exit penalties)", address: "0x000000000000000000000000000000000000dEaD" },
      ...vaultAddrs.map(([label, address]) => ({ label: `${label} vault`, address })),
      ...(genesis.address ? [{ label: "Genesis round", address: genesis.address }] : []),
      ...["MIGRATOR", "BUYBACK_BURNER", "AIRDROP"].filter(optional).map((k) => ({ label: k, address: optional(k) })),
    ];
    const missing = await missingExemptions({ required, isExempt: (a) => token.isExemptFromLimits(a) });
    for (const m of missing) check(false, m);
    console.log(`  ${required.length} protocol addresses: ${missing.length === 0 ? "all exempt ✅" : missing.length + " NOT exempt ❌"}`);
  }

  // ── Staking pool ─────────────────────────────────────────────────────────────
  console.log("\n── Staking pool ───────────────────────────────────────────");
  const rewardPool = await staking.rewardPool();
  const poolOk     = check(rewardPool === ALLOCATIONS.staking, `staking rewardPool != ${ethers.formatUnits(ALLOCATIONS.staking, 18)} SRX`);
  console.log(`  rewardPool: ${ethers.formatUnits(rewardPool, 18)} SRX  ${poolOk ? "✅" : "❌"} (expect ${ethers.formatUnits(ALLOCATIONS.staking, 18)})`);

  // ── SSF quick check ───────────────────────────────────────────────────────────
  console.log("\n── StabilisationFund ──────────────────────────────────────");
  const ssfBal   = await ssf.srxBalance();
  const ssfOk    = check(ssfBal === ALLOCATIONS.strategic, `StabilisationFund srxBalance != ${ethers.formatUnits(ALLOCATIONS.strategic, 18)} SRX`);
  console.log(`  srxBalance(): ${ethers.formatUnits(ssfBal, 18)} SRX  ${ssfOk ? "✅" : "❌"} (expect ${ethers.formatUnits(ALLOCATIONS.strategic, 18)})`);
  console.log(`  stressActive: ${await ssf.stressActive()} (expect false)`);

  console.log(`\n${"=".repeat(60)}`);
  if (failures.length === 0) {
    console.log("  ✅ TGE VERIFICATION PASSED");
  } else {
    console.log(`  ❌ TGE VERIFICATION FAILED — ${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`       • ${f}`);
    // ⛔ Non-zero, so a runbook step or CI job that checks $? actually stops.
    process.exitCode = 1;
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
