/**
 * Post-TGE verification script.
 *
 * Run after 06_execute_tge.js to confirm all allocations landed correctly.
 *
 * Run: npx hardhat run scripts/ops/verify_tge.js --network sepolia
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();

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

  const vaultSuffix = suffix; // vaults use same suffix scheme
  const vaults = {
    Founders:  env(`VAULT_FOUNDERS_${NET}${vaultSuffix}`),
    CoreTeam:  env(`VAULT_CORETEAM_${NET}${vaultSuffix}`),
    Seed:      env(`VAULT_SEEDINVESTORS_${NET}${vaultSuffix}`),
    Presale:   env(`VAULT_PRESALE_${NET}${vaultSuffix}`),
    Ecosystem: env(`VAULT_ECOSYSTEM_${NET}${vaultSuffix}`),
  };

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

  const checks = [
    { label: "StabilisationFund", addr: await ssf.getAddress(),                          expected: "1500000000" },
    { label: "SRXStaking",        addr: env(`STAKING_${NET}${suffix}`),                  expected: "1700000000" },
    { label: "SRXTreasury",       addr: env(`TREASURY_${NET}${suffix}`),                 expected: "900000000"  },
    { label: "TGEDistributor",    addr: env(`TGE_DISTRIBUTOR_${NET}${suffix}`),           expected: "0"          },
  ];

  for (const { label, addr, expected } of checks) {
    const bal = await token.balanceOf(addr);
    const expectedWei = ethers.parseUnits(expected, 18);
    const ok = bal === expectedWei;
    console.log(`  ${label.padEnd(20)}: ${ethers.formatUnits(bal, 18).padStart(16)} SRX  ${ok ? "✅" : "❌"} (expect ${expected})`);
  }

  // ── Vesting vaults ──────────────────────────────────────────────────────────
  console.log("\n── Vesting vaults ─────────────────────────────────────────");

  const expectedVaultAmounts = {
    Founders:  "1000000000",
    CoreTeam:  "600000000",
    Seed:      "400000000",
    Presale:   "1400000000",
    Ecosystem: "1300000000",
  };

  for (const [label, addr] of Object.entries(vaults)) {
    const vault     = await ethers.getContractAt("VestingVault", addr);
    const bal       = await token.balanceOf(addr);
    const triggered = await vault.tgeTriggered();
    const expected  = ethers.parseUnits(expectedVaultAmounts[label], 18);
    const balOk     = bal === expected;
    const tsStr     = triggered
      ? new Date(Number(await vault.tgeTimestamp()) * 1000).toISOString().slice(0, 19) + "Z"
      : "NOT TRIGGERED";

    check(balOk,     `${label} vault balance mismatch`);
    check(triggered, `${label} vault not triggered`);
    console.log(`  ${label.padEnd(12)}: ${ethers.formatUnits(bal, 18).padStart(16)} SRX  ${balOk ? "✅" : "❌"}  triggered=${triggered ? "✅" : "❌"}  ${tsStr}`);

    // Presale vault: check 25% immediately releasable (tgeUnlockBps = 2500)
    if (label === "Presale" && triggered) {
      const releasableNow = await vault.releasable();
      const expect25      = ethers.parseUnits(expectedVaultAmounts[label], 18) * 25n / 100n;
      const pctOk         = check(releasableNow >= expect25, "Presale vault 25% TGE unlock not releasable");
      console.log(`             releasable()=${ethers.formatUnits(releasableNow, 18)} SRX  (25% unlock: ${pctOk ? "✅" : "❌"})`);
    }
    // Cliff vaults: should be 0 releasable before cliff passes
    if ((label === "Seed" || label === "Founders" || label === "CoreTeam") && triggered) {
      const releasableNow = await vault.releasable();
      const cliffOk       = check(releasableNow === 0n, `${label} vault releasable before cliff`);
      const cliff         = await vault.cliffDuration();
      const tgeTs         = await vault.tgeTimestamp();
      const cliffEnd      = new Date((Number(tgeTs) + Number(cliff)) * 1000).toISOString().slice(0,19) + "Z";
      console.log(`             releasable()=${ethers.formatUnits(releasableNow, 18)} SRX  (pre-cliff zero: ${cliffOk ? "✅" : "❌"})  cliff ends ${cliffEnd}`);
    }
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
  const poolOk     = check(rewardPool === ethers.parseUnits("1700000000", 18), "staking rewardPool != 1,700,000,000 SRX");
  console.log(`  rewardPool: ${ethers.formatUnits(rewardPool, 18)} SRX  ${poolOk ? "✅" : "❌"} (expect 1,700,000,000)`);

  // ── SSF quick check ───────────────────────────────────────────────────────────
  console.log("\n── StabilisationFund ──────────────────────────────────────");
  const ssfBal   = await ssf.srxBalance();
  const ssfOk    = check(ssfBal === ethers.parseUnits("1500000000", 18), "StabilisationFund srxBalance != 1,500,000,000 SRX");
  console.log(`  srxBalance(): ${ethers.formatUnits(ssfBal, 18)} SRX  ${ssfOk ? "✅" : "❌"} (expect 1,500,000,000)`);
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
