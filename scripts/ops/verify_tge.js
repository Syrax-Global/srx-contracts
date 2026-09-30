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
  const checks = TGE_PLAN.filter((r) => r.kind !== "vault").map((row) => ({
    label: row.label,
    addr: row.kind === "wallet" ? walletFor(row.wallet, network.name) : contractAddr[row.label],
    expected: ethers.formatUnits(ALLOCATIONS[row.allocation], 18).replace(/\.0$/, ""),
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
    const expected  = ALLOCATIONS[row.allocation];
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

  // ── The launch-day float ─────────────────────────────────────────────────────
  // Right after TGE, the liquid rows hold exactly the published float (5%).
  {
    let liquid = 0n;
    for (const row of TGE_PLAN.filter((r) => r.liquid)) liquid += await token.balanceOf(walletFor(row.wallet, network.name));
    const ok = check(liquid === launchFloat(), `launch float ${ethers.formatUnits(liquid, 18)} SRX != ${ethers.formatUnits(launchFloat(), 18)}`);
    console.log(`\n  Launch float (liquid rows): ${ethers.formatUnits(liquid, 18)} SRX  ${ok ? "✅" : "❌"} (expect ${ethers.formatUnits(launchFloat(), 18)})`);
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
  // ⚠️ It cannot be fixed by exempting the sender: SRXToken.sol:82-88 REQUIRES
  //    DEX pool addresses to be exempt, so skipping the cap whenever the sender is
  //    exempt would let every purchase from the pool bypass it and would defeat
  //    launch protection entirely. The incompatibility is real, so it is checked
  //    here instead of being designed away.

  console.log("\n── Launch protection vs vesting ───────────────────────────");
  const walletCap = await token.maxWalletBalance();
  if (walletCap === 0n) {
    console.log("  maxWalletBalance is 0 (disabled) — no conflict possible");
  } else {
    console.log(`  maxWalletBalance: ${ethers.formatUnits(walletCap, 18)} SRX`);
    for (const [label, addr] of Object.entries(vaults)) {
      if (addr === ethers.ZeroAddress) continue;
      const vault = await ethers.getContractAt("VestingVault", addr);
      const ben   = await vault.beneficiary();
      if (await token.isExemptFromLimits(ben)) {
        console.log(`  ${label.padEnd(12)}: beneficiary exempt ✅`);
        continue;
      }
      const releasableNow = await vault.releasable();
      const benBal        = await token.balanceOf(ben);
      const wouldExceed   = benBal + releasableNow > walletCap;
      check(!wouldExceed,
        `${label} beneficiary cannot claim: ${ethers.formatUnits(releasableNow, 18)} SRX releasable would breach the ${ethers.formatUnits(walletCap, 18)} SRX wallet cap`);
      console.log(`  ${label.padEnd(12)}: releasable ${ethers.formatUnits(releasableNow, 18)} SRX  ${wouldExceed ? "❌ WOULD REVERT" : "✅"}`);
    }
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
