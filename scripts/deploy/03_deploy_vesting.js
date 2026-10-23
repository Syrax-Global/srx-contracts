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
 * ⭐ The Genesis round is funded from the seed allocation (lib/genesis_seed.js): the
 *    Genesis contract receives exactly what it sold and the seed vault the rest. The
 *    round must be CLOSED before this step; the script refuses, having sent nothing,
 *    if it is still open. PRESALE_ROUND_<NETWORK> names it, or "none".
 *
 * ⭐ The rows are read from TGE_PLAN, not written out here, so this script, the TGE
 *    gate (lib/tge_targets.js) and the generated tokenomics cannot disagree.
 *
 * ⭐ THE VAULTS' ADMIN IS THE TIMELOCK (Jared, 30 Sep 2026). A vault's admin can
 *    revoke() it and send the unvested remainder anywhere; behind the Timelock that
 *    is a public 48-hour proposal, not an instant Safe power. The vault admin also
 *    declares each grant and starts each clock, so this script SCHEDULES those two
 *    as Timelock operations (lib/vaultOps.js); 06_execute_tge executes them.
 *
 * Prerequisites:
 *  - SRXToken deployed (Step 1) — SRX_TOKEN_<NETWORK> set in .env
 *  - Governance deployed (Step 2) — TIMELOCK_<NETWORK> set in .env
 *  - ⛔ SRXTreasury deployed (Step 5, which runs right after Step 2) — TREASURY_<NETWORK> set
 *    in .env. REQUIRED, with no fallback: every vault's `revokeRecipient` is fixed at
 *    deployment and can never be changed, and it must be the SRXTreasury CONTRACT, never a
 *    wallet. A placeholder wallet cannot be "upgraded later": the recipient is immutable
 *    (E-02, review E, 22 Oct 2026). The script stops, having deployed nothing, if it is
 *    missing, has no code, or is not the SRXTreasury of this token.
 *
 * Documented order: 01 → 02 → 05 → 10 → 03 → 04 → 05b → 06 → 06b → 08 (see lib/launch_order.js).
 *
 * Run: npx hardhat run scripts/deploy/03_deploy_vesting.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { WALLETS, ALLOCATIONS, VESTING, TGE_PLAN } = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");
const { vaultOps } = require("./lib/vaultOps");
const { launchPlan, readGenesisSold } = require("./lib/genesis_seed");
const { requireTreasury, assertStep3MayRun, REDEPLOY_ACK } = require("./lib/launch_order");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying Vesting Vaults + TGEDistributor on ${network.name}`);

  const srxToken  = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
  const staking   = process.env[`STAKING_${network.name.toUpperCase()}`]  || WALLETS.staking;
  const admin     = WALLETS.admin;
  const timelockAddr = process.env[`TIMELOCK_${network.name.toUpperCase()}`];

  if (!srxToken) throw new Error(`SRX_TOKEN_${network.name.toUpperCase()} not set in .env`);
  if (!timelockAddr) throw new Error(`TIMELOCK_${network.name.toUpperCase()} not set in .env — run Step 2 first; the vaults' admin is the Timelock`);
  const timelock = await ethers.getContractAt("SRXTimelock", timelockAddr);

  // ⛔ E-01: this step deploys a NEW TGEDistributor. Refuse if staking or the fund (which fix the
  //    distributor immutably) were already built against the current one, unless acknowledged.
  const rerun = assertStep3MayRun({ networkName: network.name, env: process.env });
  if (rerun.redeploying) {
    console.warn(`\n⛔ ${REDEPLOY_ACK}=yes: ${rerun.declared.join(" and ")} stay bound to the OLD TGEDistributor. 06 will refuse to launch until`);
    console.warn(`   Step 4 (staking + fee controller) and Step 5b (stabilisation fund) are re-run against the new one and their addresses replaced in .env`);
    console.warn(`   (and Step 8, if it already ran, is redone or its modules re-targeted by governance).`);
  }

  // ⛔ The vaults' revokeRecipient is immutable: it is the SRXTreasury, which must exist already.
  const treasury = await requireTreasury({
    networkName: network.name, provider: ethers.provider, tokenAddress: srxToken,
    forWhat: "Step 3 (every launch vault's revokeRecipient)",
  });

  // ── The Genesis round is funded from the seed allocation ─────────────────
  //
  // ⭐ Read BEFORE anything is deployed: the seed vault's grant, scheduled below,
  //    is the seed allocation minus what the Genesis round sold, so the round must
  //    be closed. readGenesisSold refuses otherwise, and nothing has been sent.
  const genesis = await readGenesisSold({ networkName: network.name, provider: ethers.provider, tokenAddress: srxToken });
  const { plan, allocations: amounts } = launchPlan(genesis.sold);
  if (genesis.sold > 0n) {
    console.log(`\nGenesis round ${genesis.address} is closed and sold ${ethers.formatUnits(genesis.sold, 18)} SRX.`);
    console.log(`  Seed allocation ${ethers.formatUnits(ALLOCATIONS.seedInvestors, 18)} SRX → Genesis contract ${ethers.formatUnits(amounts.genesis, 18)} + seed vault ${ethers.formatUnits(amounts.seedInvestors, 18)}`);
  } else {
    console.log(`\nNo Genesis round sold anything: the whole seed allocation goes to the seed vault.`);
  }

  const VestingVault = await ethers.getContractFactory("VestingVault");

  // ── Deploy vesting vaults ─────────────────────────────────────────────────

  console.log("\nDeploying VestingVaults...");

  const vaults = {};        // label → vault address
  const vaultContracts = {}; // label → contract
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    const v = VESTING[row.schedule];
    const vault = await VestingVault.deploy(
      srxToken, WALLETS[row.beneficiary], timelockAddr,
      v.cliffDuration, v.vestingDuration, v.tgeUnlockBps,
      treasury // revokeRecipient: the SRXTreasury contract, fixed at deployment (internal audit M2, E-02)
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

  // declareExpectedAllocation() and triggerTGE() are gated by each vault's
  // immutable `admin` — the Timelock — so both are scheduled as Timelock
  // operations here, by the admin Safe (the Timelock's admin until hand-over),
  // never by the deployer (SC-TRUST-002). One batch covers these and
  // TGEDistributor.setAllocations() below.
  const batch = createAdminBatch("03_vesting");

  const PROPOSER = await timelock.PROPOSER_ROLE();
  const minDelay = await timelock.getMinDelay();
  const ops = vaultOps(vaults, amounts);
  console.log(`\nScheduling the vault setup through the Timelock (ready after ${minDelay}s)...`);
  if (!(await timelock.hasRole(PROPOSER, admin))) {
    await batch.send(timelock, "grantRole", [PROPOSER, admin],
      "Timelock: grant PROPOSER → admin Safe (TEMPORARY — to schedule the vault setup; revoked in migrate_roles phase 2)");
  }
  for (const [name, op] of [["declare every grant", ops.declare], ["start every vesting clock", ops.trigger]]) {
    if (await timelock.isOperation(op.id)) { console.log(`  ✓ (already scheduled) ${name}`); continue; }
    await batch.send(timelock, "scheduleBatch", [...op.args, minDelay], `Timelock: schedule — ${name} (${op.targets.length} vaults)`);
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

  const contractDestination = { Staking: staking, Treasury: treasury, StabilisationFund: WALLETS.strategic, Genesis: genesis.address };
  const allocations = plan.map((row) => ({
    destination:
      row.kind === "vault"  ? vaults[row.label] :
      row.kind === "wallet" ? WALLETS[row.wallet] :
      contractDestination[row.label],
    amount: amounts[row.allocation],
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
  console.log(`\n⏳ The vault setup executes in Step 6, at least ${minDelay}s after the Safe runs this batch.`);
  console.log(`\nNext steps:`);
  console.log(`  4. Deploy Staking + FeeController (Step 4)`);
  console.log(`  5b. Deploy the Stabilisation Fund (Step 5b)`);
  console.log(`  6. Execute TGE (Step 6) — mints + distributes + triggers vesting`);

  return { vaults, tgeAddress };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
