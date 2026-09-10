/**
 * Test: StabilisationFund stress event lifecycle
 *
 * Tests the full trigger → deploy → cap enforcement → resolve → cooldown cycle.
 *
 * Uses TWO signers:
 *  - deployer  → ORACLE_REPORTER_ROLE + GOVERNANCE_ROLE  (trigger + resolve)
 *  - investor  → DEPLOYER_ROLE only                      (cap enforcement test)
 *
 * IMPORTANT: The two-signer approach is critical. If a single wallet holds both
 * DEPLOYER_ROLE and GOVERNANCE_ROLE, deployLiquidity() routes through the
 * governance path (checked first, no cap) — making the cap test a false positive.
 *
 * Prerequisites:
 *  - STABILISATION_FUND_SEPOLIA_TGE (or STABILISATION_FUND_SEPOLIA) set in .env
 *  - SRX_TOKEN_SEPOLIA_TGE (or SRX_TOKEN_SEPOLIA) set in .env
 *  - INVESTOR_PRIVATE_KEY set in .env (wallet used for DEPLOYER_ROLE only)
 *  - TGE executed (SSF must hold SRX)
 *  - Deployer has DEFAULT_ADMIN_ROLE on SSF
 *
 * Run: npx hardhat run scripts/ops/test_ssf_stress.js --network sepolia
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET = network.name.toUpperCase();

  // Prefer TGE test stack addresses if present
  const suffix    = process.env[`STABILISATION_FUND_${NET}_TGE`] ? `_TGE` : ``;
  const ssfAddr   = process.env[`STABILISATION_FUND_${NET}${suffix}`];
  const tokenAddr = process.env[`SRX_TOKEN_${NET}${suffix}`];
  if (!ssfAddr)   throw new Error(`STABILISATION_FUND_${NET}${suffix} not set in .env`);
  if (!tokenAddr) throw new Error(`SRX_TOKEN_${NET}${suffix} not set in .env`);
  if (suffix) console.log(`ℹ️  Using TGE test stack addresses`);

  // ── Second signer: holds DEPLOYER_ROLE only (not GOVERNANCE_ROLE) ─────────
  const investorKey = process.env.INVESTOR_PRIVATE_KEY;
  let deployerRoleSigner;
  if (investorKey) {
    deployerRoleSigner = new ethers.Wallet(investorKey, ethers.provider);
    console.log(`ℹ️  Using investor wallet for DEPLOYER_ROLE cap test`);
    console.log(`    Investor: ${deployerRoleSigner.address}`);
  } else {
    deployerRoleSigner = deployer;
    console.log(`⚠️  No INVESTOR_PRIVATE_KEY — using deployer for all roles`);
    console.log(`    Cap enforcement test will be inaccurate if deployer holds GOVERNANCE_ROLE`);
  }

  const ssf   = await ethers.getContractAt("StabilisationFund", ssfAddr);
  const token = await ethers.getContractAt("SRXToken",          tokenAddr);

  console.log(`\nNetwork:       ${network.name}`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`SSF:           ${ssfAddr}`);
  console.log(`SSF SRX bal:   ${ethers.formatUnits(await ssf.srxBalance(), 18)} SRX`);
  console.log(`stressActive:  ${await ssf.stressActive()}\n`);

  if ((await ssf.srxBalance()) === 0n) {
    console.log("⚠️  SSF has 0 SRX balance. Execute TGE first (deploy_tge_teststack.js).");
    return;
  }

  // ── Grant roles ───────────────────────────────────────────────────────────
  const ORACLE_ROLE   = await ssf.ORACLE_REPORTER_ROLE();
  const DEPLOYER_ROLE = await ssf.DEPLOYER_ROLE();
  const GOV_ROLE      = await ssf.GOVERNANCE_ROLE();

  // Deployer: oracle + governance only
  if (!await ssf.hasRole(ORACLE_ROLE, deployer.address)) {
    console.log("Granting ORACLE_REPORTER_ROLE to deployer...");
    await (await ssf.grantRole(ORACLE_ROLE, deployer.address)).wait();
  }
  if (!await ssf.hasRole(GOV_ROLE, deployer.address)) {
    console.log("Granting GOVERNANCE_ROLE to deployer...");
    await (await ssf.grantRole(GOV_ROLE, deployer.address)).wait();
  }

  // Investor signer: DEPLOYER_ROLE only (no governance — cap test accuracy)
  if (!await ssf.hasRole(DEPLOYER_ROLE, deployerRoleSigner.address)) {
    console.log(`Granting DEPLOYER_ROLE to ${deployerRoleSigner.address === deployer.address ? "deployer" : "investor"}...`);
    await (await ssf.grantRole(DEPLOYER_ROLE, deployerRoleSigner.address)).wait();
  }
  // If investor is separate, ensure it does NOT hold GOV_ROLE (invalidates cap test)
  if (deployerRoleSigner.address !== deployer.address &&
      await ssf.hasRole(GOV_ROLE, deployerRoleSigner.address)) {
    console.log(`ℹ️  Revoking GOVERNANCE_ROLE from investor (ensures cap test uses DEPLOYER_ROLE path)...`);
    await (await ssf.revokeRole(GOV_ROLE, deployerRoleSigner.address)).wait();
  }

  // SSF connected as investor (DEPLOYER_ROLE only — cap-enforced path)
  const ssfAsInvestor = ssf.connect(deployerRoleSigner);

  // Track pass/fail for accurate summary
  const results = { trigger: false, cap: false, resolve: false, cooldown: false };

  // ── Step 1: Trigger stress event ─────────────────────────────────────────
  if (await ssf.stressActive()) {
    console.log("[1] Stress already active — skipping trigger.");
    results.trigger = true;
  } else {
    console.log("[1] Triggering stress event (ORACLE_REPORTER_ROLE)...");
    const tx      = await ssf.triggerStressEvent();
    const receipt = await tx.wait();
    console.log(`✅ StressEventTriggered — block ${receipt.blockNumber}`);
    results.trigger = true;
  }
  const stressNowActive = await ssf.stressActive();
  console.log(`    stressActive: ${stressNowActive} (expect true)`);
  if (!stressNowActive) {
    console.log("❌ stress is not active — cannot proceed");
    return;
  }

  // ── Step 2: Deploy up to 30% cap (via DEPLOYER_ROLE signer) ──────────────
  const stressStartBal = await ssf.stressStartSRXBalance();
  const maxDeployerBps = await ssf.maxDeployerBps();
  const cap            = stressStartBal * maxDeployerBps / 10000n;
  const deployerUsed   = await ssf.deployerSRXUsed();
  const guardianUsed   = await ssf.guardianSRXUsed();
  const combinedUsed   = deployerUsed + guardianUsed;

  console.log(`\n[2] DEPLOYER_ROLE cap test (signer: ${deployerRoleSigner.address === deployer.address ? "deployer" : "investor"})`);
  console.log(`    stressStartSRXBalance: ${ethers.formatUnits(stressStartBal, 18)} SRX`);
  console.log(`    maxDeployerBps:        ${maxDeployerBps} (${Number(maxDeployerBps)/100}%)`);
  console.log(`    30% cap =              ${ethers.formatUnits(cap, 18)} SRX`);
  console.log(`    deployerSRXUsed:       ${ethers.formatUnits(deployerUsed, 18)} SRX`);
  console.log(`    guardianSRXUsed:       ${ethers.formatUnits(guardianUsed, 18)} SRX`);
  console.log(`    combinedUsed:          ${ethers.formatUnits(combinedUsed, 18)} SRX`);

  if (combinedUsed >= cap) {
    console.log(`    Cap already fully used — skipping deployment, proceeding to exceed-cap test`);
    results.cap = true;
  } else {
    const remaining = cap - combinedUsed;
    console.log(`    Deploying ${ethers.formatUnits(remaining, 18)} SRX via DEPLOYER_ROLE...`);
    try {
      const tx2 = await ssfAsInvestor.deployLiquidity(
        deployerRoleSigner.address, tokenAddr, remaining, "Testnet: stress test deployment"
      );
      await tx2.wait();
      const afterUsed = await ssf.deployerSRXUsed();
      console.log(`✅ Deployed successfully`);
      console.log(`    deployerSRXUsed (after): ${ethers.formatUnits(afterUsed, 18)} SRX`);
    } catch (e) {
      console.log(`❌ Deployment failed unexpectedly: ${e.message.slice(0, 150)}`);
    }
  }

  // ── Step 3: Exceed cap — must revert ─────────────────────────────────────
  console.log("\n[3] Attempting to exceed 30% cap via DEPLOYER_ROLE (expect revert)...");
  try {
    await ssfAsInvestor.deployLiquidity(
      deployerRoleSigner.address, tokenAddr, ethers.parseUnits("1", 18), "Should fail"
    );
    console.log("❌ FAIL — did not revert, cap not enforced!");
    results.cap = false;
  } catch (e) {
    const msg = e.message.slice(0, 120);
    console.log(`✅ Correctly reverted: ${msg}`);
    results.cap = true;
  }

  // ── Step 4: Resolve stress event ─────────────────────────────────────────
  console.log("\n[4] Resolving stress event (GOVERNANCE_ROLE)...");
  try {
    const tx4 = await ssf.resolveStressEvent();
    const r4   = await tx4.wait();
    console.log(`✅ StressEventResolved — block ${r4.blockNumber}`);
    console.log(`    stressActive: ${await ssf.stressActive()} (expect false)`);
    const resolvedAt  = await ssf.stressResolvedAt();
    const cooldown    = await ssf.stressCooldownDuration();
    const cooldownEnd = new Date((Number(resolvedAt) + Number(cooldown)) * 1000).toISOString();
    console.log(`    Cooldown ends: ${cooldownEnd}`);
    results.resolve = true;
  } catch (e) {
    console.log(`❌ resolveStressEvent() failed: ${e.message.slice(0, 150)}`);
  }

  // ── Step 5: Immediate re-trigger — should hit cooldown ───────────────────
  console.log("\n[5] Immediately re-triggering (expect StressInCooldown revert)...");
  try {
    await ssf.triggerStressEvent();
    console.log("❌ FAIL — did not revert, cooldown not enforced!");
    results.cooldown = false;
  } catch (e) {
    const msg = e.message.slice(0, 120);
    console.log(`✅ Correctly reverted with cooldown: ${msg}`);
    results.cooldown = true;
  }

  // ── Summary (accurate — not hardcoded) ────────────────────────────────────
  console.log("\n── Summary ────────────────────────────────────────────────");
  console.log(`${results.trigger  ? "✅" : "❌"} Stress trigger:      ${results.trigger  ? "PASS" : "FAIL"}`);
  console.log(`${results.cap      ? "✅" : "❌"} 30% cap enforcement: ${results.cap      ? "PASS" : "FAIL"}`);
  console.log(`${results.resolve  ? "✅" : "❌"} Resolve:             ${results.resolve  ? "PASS" : "FAIL"}`);
  console.log(`${results.cooldown ? "✅" : "❌"} Cooldown enforcement:${results.cooldown ? "PASS" : "FAIL"}`);

  const allPass = Object.values(results).every(Boolean);
  console.log(`\n${allPass ? "✅ ALL STRESS TEST CHECKS PASSED" : "❌ ONE OR MORE CHECKS FAILED — review output above"}`);
  console.log(`\nℹ️  Re-trigger after cooldown: wait until cooldown ends, then run this script again`);
  console.log(`ℹ️  GOVERNANCE_ROLE unlimited deployment is separately exercised by resolve + deployLiquidity via Timelock`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
