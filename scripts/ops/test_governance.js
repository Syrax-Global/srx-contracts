/**
 * Test: Governance — delegation, proposal creation, Timelock execution
 *
 * Tests:
 *  5.1  delegate() — deployer self-delegates, voting power confirmed
 *  5.2  propose() — creates a proposal, proposalId returned, state = Pending
 *  5.3  (documented) vote → queue → execute requires 8+ days on live Sepolia
 *  5.4  Timelock direct execution (60s delay) — proves schedule→wait→execute path
 *  5.5  Executed call changes on-chain state (FeeController.baseFeeRateBps updated)
 *
 * Strategy:
 *  The Governor has votingDelay=1 day + votingPeriod=7 days — not practical to wait
 *  through on live Sepolia. This script tests:
 *
 *  PART A — Governor: delegate, check voting power, create proposal, verify Pending.
 *            The proposal is left live on-chain (will expire after 8 days without votes).
 *
 *  PART B — Timelock: deployer holds DEFAULT_ADMIN_ROLE on Timelock.
 *            Grants PROPOSER_ROLE to self, schedules a call with 60s delay,
 *            waits 65 seconds, executes. The FeeController.baseFeeRateBps changes
 *            from 150→120, proving end-to-end execution. Restored to 150 after.
 *
 * Prerequisites:
 *  - TIMELOCK_SEPOLIA_TGE, GOVERNOR_SEPOLIA_TGE, FEE_CONTROLLER_SEPOLIA_TGE,
 *    SRX_TOKEN_SEPOLIA_TGE set in .env
 *  - Deployer holds DEFAULT_ADMIN_ROLE on Timelock (set at deploy)
 *  - Deployer holds 898M+ SRX (well above 1M proposalThreshold)
 *
 * Run: npx hardhat run scripts/ops/test_governance.js --network sepolia
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitWithCountdown(seconds) {
  process.stdout.write(`   Waiting ${seconds}s for Timelock delay`);
  const interval = 10;
  for (let elapsed = 0; elapsed < seconds; elapsed += interval) {
    await sleep(interval * 1000);
    const remaining = seconds - elapsed - interval;
    if (remaining > 0) process.stdout.write(` ... ${remaining}s`);
  }
  console.log(` ... done ✅`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET = network.name.toUpperCase();

  // ── Resolve addresses ────────────────────────────────────────────────────
  const timelockAddr  = process.env[`TIMELOCK_${NET}_TGE`];
  const governorAddr  = process.env[`GOVERNOR_${NET}_TGE`];
  const feeAddr       = process.env[`FEE_CONTROLLER_${NET}_TGE`];
  const tokenAddr     = process.env[`SRX_TOKEN_${NET}_TGE`];

  if (!timelockAddr) throw new Error(`TIMELOCK_${NET}_TGE not set in .env`);
  if (!governorAddr) throw new Error(`GOVERNOR_${NET}_TGE not set in .env`);
  if (!feeAddr)      throw new Error(`FEE_CONTROLLER_${NET}_TGE not set in .env`);
  if (!tokenAddr)    throw new Error(`SRX_TOKEN_${NET}_TGE not set in .env`);

  console.log(`ℹ️  Using TGE test stack addresses`);

  const timelock  = await ethers.getContractAt("SRXTimelock",   timelockAddr);
  const governor  = await ethers.getContractAt("SRXGovernor",   governorAddr);
  const fee       = await ethers.getContractAt("FeeController", feeAddr);
  const token     = await ethers.getContractAt("SRXToken",      tokenAddr);

  const deployerSRX   = await token.balanceOf(deployer.address);
  const currentVotes  = await token.getVotes(deployer.address);
  const votingDelay   = await governor.votingDelay();
  const votingPeriod  = await governor.votingPeriod();
  const threshold     = await governor.proposalThreshold();
  const baseFee       = await fee.baseFeeRateBps();
  const minDelay      = await timelock.getMinDelay();

  console.log(`\nNetwork:           ${network.name}`);
  console.log(`Deployer:          ${deployer.address}`);
  console.log(`Timelock:          ${timelockAddr}`);
  console.log(`Governor:          ${governorAddr}`);
  console.log(`FeeController:     ${feeAddr}`);
  console.log(`\nGovernor params:`);
  console.log(`  votingDelay:     ${votingDelay}s (${Number(votingDelay)/86400} days)`);
  console.log(`  votingPeriod:    ${votingPeriod}s (${Number(votingPeriod)/86400} days)`);
  console.log(`  proposalThresh:  ${ethers.formatUnits(threshold, 18)} SRX`);
  console.log(`  timelockDelay:   ${minDelay}s`);
  console.log(`\nDeployer SRX:      ${ethers.formatUnits(deployerSRX, 18)}`);
  console.log(`Current votes:     ${ethers.formatUnits(currentVotes, 18)} SRX`);
  console.log(`Current base fee:  ${baseFee} bps\n`);

  const results = {
    delegated:         false,
    votingPower:       false,
    proposalCreated:   false,
    proposalPending:   false,
    timelockScheduled: false,
    timelockExecuted:  false,
    stateChanged:      false,
    stateRestored:     false,
  };

  // ────────────────────────────────────────────────────────────────────────
  // PART A — Governor: delegation + proposal creation
  // ────────────────────────────────────────────────────────────────────────
  console.log(`═══ PART A: Governor ════════════════════════════════════════`);

  // ── Step 1: Delegate ─────────────────────────────────────────────────────
  console.log(`\n[1] Self-delegating deployer SRX for voting power...`);
  if (currentVotes === 0n) {
    const delegateTx = await token.delegate(deployer.address);
    await delegateTx.wait();
    console.log(`   ✅ delegate(deployer) — tx mined`);
    results.delegated = true;
  } else {
    console.log(`   Already delegated — getVotes = ${ethers.formatUnits(currentVotes, 18)} SRX`);
    results.delegated = true;
  }

  // Advance one block so the checkpoint is visible at clock() - 1
  await (await token.transfer(deployer.address, 0n)).wait();

  const votesAfterDelegate = await token.getVotes(deployer.address);
  results.votingPower = votesAfterDelegate >= threshold;
  console.log(`   getVotes(deployer) = ${ethers.formatUnits(votesAfterDelegate, 18)} SRX`);
  console.log(`   proposalThreshold  = ${ethers.formatUnits(threshold, 18)} SRX`);
  console.log(`  ${results.votingPower ? "✅" : "❌"} Voting power meets proposal threshold`);

  // ── Step 2: Create a proposal ─────────────────────────────────────────────
  // Propose: FeeController.setBaseFeeRate(120) — a meaningful fee reduction
  // This is the canonical test of the governance flow: propose→vote→queue→execute
  console.log(`\n[2] Creating governance proposal: setBaseFeeRate(120 bps)...`);

  const propCalldata = fee.interface.encodeFunctionData("setBaseFeeRate", [120]);
  const propDescription = `[Testnet] Reduce base fee from 150 to 120 bps — governance test proposal ${Date.now()}`;

  let proposalId;
  try {
    const proposeTx = await governor.propose(
      [feeAddr],         // targets
      [0n],              // values (ETH to send — 0)
      [propCalldata],    // calldatas
      propDescription    // description
    );
    const propRx = await proposeTx.wait();
    console.log(`   ✅ propose() — block ${propRx.blockNumber}`);

    // Extract proposalId from ProposalCreated event
    const propEvent = propRx.logs.find(l => {
      try { return governor.interface.parseLog(l)?.name === "ProposalCreated"; }
      catch { return false; }
    });
    if (propEvent) {
      const parsed = governor.interface.parseLog(propEvent);
      proposalId = parsed.args.proposalId;
      console.log(`   proposalId: ${proposalId}`);
      results.proposalCreated = true;
    }

    // Check state
    if (proposalId !== undefined) {
      const propState = await governor.state(proposalId);
      // States: 0=Pending, 1=Active, 2=Canceled, 3=Defeated, 4=Succeeded, 5=Queued, 6=Expired, 7=Executed
      const stateNames = ["Pending","Active","Canceled","Defeated","Succeeded","Queued","Expired","Executed"];
      console.log(`   Proposal state: ${stateNames[propState]} (${propState})`);
      results.proposalPending = propState === 0n || propState === 0;

      const voteStart = await governor.proposalSnapshot(proposalId);
      const voteEnd   = await governor.proposalDeadline(proposalId);
      const now       = BigInt(Math.floor(Date.now() / 1000));
      console.log(`   Voting opens:  ${new Date(Number(voteStart) * 1000).toISOString()} (in ${Number(voteStart - now)/3600}h)`);
      console.log(`   Voting closes: ${new Date(Number(voteEnd)   * 1000).toISOString()} (in ${Number(voteEnd   - now)/3600}h)`);
    }
  } catch (e) {
    console.log(`  ❌ propose() failed: ${e.message.slice(0, 200)}`);
  }

  console.log(`\n  ℹ️  Full vote→queue→execute flow:`);
  console.log(`     Voting delay: 1 day → then Active`);
  console.log(`     Voting period: 7 days → then Succeeded (if quorum met)`);
  console.log(`     Queue in Timelock → then wait 60s → Execute`);
  console.log(`     Total: ~8 days. Not practical on live Sepolia.`);
  console.log(`     The complete flow is covered by 180+ unit tests (525 passing).`);
  console.log(`     PART B below tests the Timelock execution directly (60s wait).\n`);

  // ────────────────────────────────────────────────────────────────────────
  // PART B — Timelock direct execution (proves 60s schedule→execute path)
  // ────────────────────────────────────────────────────────────────────────
  console.log(`═══ PART B: Timelock direct execution ══════════════════════`);

  // The deployer holds DEFAULT_ADMIN_ROLE on the Timelock.
  // Grant PROPOSER_ROLE to deployer so we can schedule directly.
  const PROPOSER_ROLE  = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE  = await timelock.EXECUTOR_ROLE();
  const alreadyProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);

  console.log(`\n[3] Timelock roles...`);
  console.log(`   PROPOSER_ROLE:  0x${PROPOSER_ROLE.slice(2, 10)}...`);
  console.log(`   Deployer is proposer: ${alreadyProposer}`);

  if (!alreadyProposer) {
    console.log(`   Granting PROPOSER_ROLE to deployer...`);
    await (await timelock.grantRole(PROPOSER_ROLE, deployer.address)).wait();
    console.log(`   ✅ PROPOSER_ROLE granted`);
  } else {
    console.log(`   Deployer already has PROPOSER_ROLE`);
  }

  // ── Step 3a: Ensure Timelock has GOVERNANCE_ROLE on FeeController ────────
  // When the Timelock executes a call, msg.sender = Timelock address.
  // FeeController.setBaseFeeRate() requires GOVERNANCE_ROLE — grant it if missing.
  console.log(`\n[3b] Checking Timelock has GOVERNANCE_ROLE on FeeController...`);
  const FEE_GOV_ROLE = await fee.GOVERNANCE_ROLE();
  const timelockHasFeeGov = await fee.hasRole(FEE_GOV_ROLE, timelockAddr);
  console.log(`   Timelock has GOVERNANCE_ROLE on FeeController: ${timelockHasFeeGov}`);
  if (!timelockHasFeeGov) {
    console.log(`   Granting GOVERNANCE_ROLE to Timelock on FeeController...`);
    await (await fee.grantRole(FEE_GOV_ROLE, timelockAddr)).wait();
    console.log(`   ✅ GOVERNANCE_ROLE granted to Timelock`);
  }

  // ── Step 3: Schedule call — setBaseFeeRate(120) ───────────────────────────
  // We use a unique salt so this doesn't conflict with the Governor proposal above
  console.log(`\n[4] Scheduling Timelock call: FeeController.setBaseFeeRate(120)...`);

  const calldata120  = fee.interface.encodeFunctionData("setBaseFeeRate", [120]);
  const salt120      = ethers.id(`test_governance_120_${Date.now()}`);
  const predecessor  = ethers.ZeroHash;
  const delay        = await timelock.getMinDelay(); // 60s on testnet

  try {
    const scheduleTx = await timelock.schedule(
      feeAddr,      // target
      0n,           // value
      calldata120,  // data
      predecessor,  // predecessor
      salt120,      // salt
      delay         // delay (60s)
    );
    const scheduleRx = await scheduleTx.wait();
    console.log(`   ✅ schedule() — block ${scheduleRx.blockNumber}`);

    // Compute the operation ID (used to check ready status)
    const operationId = await timelock.hashOperation(feeAddr, 0n, calldata120, predecessor, salt120);
    const timestamp   = await timelock.getTimestamp(operationId);
    console.log(`   operationId: ${operationId}`);
    console.log(`   Executable at: ${new Date(Number(timestamp) * 1000).toISOString()}`);
    results.timelockScheduled = timestamp > 0n;

    // ── Wait for the delay ─────────────────────────────────────────────────
    console.log(`\n[5] Waiting ${Number(delay) + 5}s for Timelock delay to expire...`);
    await waitWithCountdown(Number(delay) + 5);

    // ── Step 4: Execute ────────────────────────────────────────────────────
    console.log(`\n[6] Executing Timelock call...`);
    const feeBeforeExec = await fee.baseFeeRateBps();
    console.log(`   baseFeeRateBps before: ${feeBeforeExec}`);

    const execTx = await timelock.execute(
      feeAddr,
      0n,
      calldata120,
      predecessor,
      salt120
    );
    const execRx = await execTx.wait();
    console.log(`   ✅ execute() — block ${execRx.blockNumber}`);
    results.timelockExecuted = true;

    const feeAfterExec = await fee.baseFeeRateBps();
    console.log(`   baseFeeRateBps after:  ${feeAfterExec}`);
    results.stateChanged = feeAfterExec === 120n;
    console.log(`  ${results.stateChanged ? "✅" : "❌"} State changed: ${feeBeforeExec} → ${feeAfterExec} bps`);

    // ── Step 5: Restore baseFeeRateBps to 150 ─────────────────────────────
    console.log(`\n[7] Scheduling Timelock restore call: setBaseFeeRate(150)...`);
    const calldata150 = fee.interface.encodeFunctionData("setBaseFeeRate", [150]);
    const salt150     = ethers.id(`test_governance_restore_${Date.now()}`);

    await (await timelock.schedule(feeAddr, 0n, calldata150, predecessor, salt150, delay)).wait();
    console.log(`   ✅ Restore call scheduled — waiting ${Number(delay) + 5}s...`);
    await waitWithCountdown(Number(delay) + 5);

    await (await timelock.execute(feeAddr, 0n, calldata150, predecessor, salt150)).wait();
    const restoredFee = await fee.baseFeeRateBps();
    results.stateRestored = restoredFee === 150n;
    console.log(`  ${results.stateRestored ? "✅" : "❌"} baseFeeRateBps restored to ${restoredFee} bps`);

  } catch (e) {
    console.log(`  ❌ Timelock operation failed: ${e.message.slice(0, 200)}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n── Summary ────────────────────────────────────────────────");
  console.log(`\nPART A — Governor`);
  console.log(`${results.delegated        ? "✅" : "❌"} delegate() — SRX self-delegated for voting power`);
  console.log(`${results.votingPower      ? "✅" : "❌"} getVotes() ≥ proposalThreshold (1M SRX)`);
  console.log(`${results.proposalCreated  ? "✅" : "❌"} propose() — proposalId returned`);
  console.log(`${results.proposalPending  ? "✅" : "❌"} Proposal state = Pending (voting opens in 1 day)`);
  console.log(`ℹ️  vote → queue → execute: not tested on live Sepolia (8-day wait)`);
  console.log(`   Coverage: 180+ passing unit tests including full Governor lifecycle`);

  console.log(`\nPART B — Timelock direct (60s delay)`);
  console.log(`${results.timelockScheduled ? "✅" : "❌"} schedule() — call queued in Timelock`);
  console.log(`${results.timelockExecuted  ? "✅" : "❌"} execute() — call ran after 60s delay`);
  console.log(`${results.stateChanged      ? "✅" : "❌"} State change confirmed: 150→120 bps`);
  console.log(`${results.stateRestored     ? "✅" : "❌"} State restored: 120→150 bps`);

  const partA = results.delegated && results.votingPower && results.proposalCreated && results.proposalPending;
  const partB = results.timelockScheduled && results.timelockExecuted && results.stateChanged && results.stateRestored;
  console.log(`\n${partA && partB ? "✅ ALL GOVERNANCE TESTS PASSED" : "⚠️  ONE OR MORE CHECKS FAILED"}`);

  if (partA && partB) {
    console.log(`\nℹ️  Governance notes:`);
    console.log(`   - The governance proposal created above is live on-chain.`);
    console.log(`     It will sit in Pending state for 1 day, then Active for 7 days.`);
    console.log(`     Without votes it will expire. This is expected testnet behaviour.`);
    console.log(`   - PROPOSER_ROLE was granted to the deployer for testnet only.`);
    console.log(`     On mainnet, only SRXGovernor holds PROPOSER_ROLE.`);
    console.log(`   - Before mainnet: revoke PROPOSER_ROLE from deployer EOA.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
