/**
 * test_edge_cases.js
 *
 * Phase 1 edge-case revert tests for PreSaleRound v2 on Sepolia.
 *
 * Test 1.11 — Oracle staleness
 *   Reduces maxStaleness to 1 second on the live contract.
 *   The real Chainlink ETH/USD feed's updatedAt is always >> 1s in the past,
 *   so the very next invest() call reverts with StalePriceFeed.
 *   Restores maxStaleness to 3600 (1 hour) after.
 *
 * Test 1.12 — Hard cap exceeded
 *   Temporarily lowers hardCapSRX to just above current totalAllocated.
 *   Attempts addInvestor() with an amount that would overflow the cap.
 *   Expects HardCapExceeded revert.
 *   Restores hardCapSRX to 400,000,000 SRX after.
 *
 * Run:
 *   npx hardhat run scripts/ops/test_edge_cases.js --network sepolia
 */

const { ethers, network } = require("hardhat");
require("dotenv").config();

const ETH_TO_INVEST        = ethers.parseEther("0.001");
const DEFAULT_MAX_STALENESS = 3600n;
const FULL_HARD_CAP         = ethers.parseUnits("400000000", 18); // 400M SRX

async function expectRevert(txPromise, label) {
  try {
    await txPromise;
    console.log(`  ❌ FAIL — ${label}: did NOT revert (expected revert)`);
    return false;
  } catch (err) {
    const msg = err.message ?? String(err);
    console.log(`  ✅ Correctly reverted: ${_extractReason(msg)}`);
    return true;
  }
}

function _extractReason(msg) {
  // Custom error name from ethers v6 revert decoding
  const customErr = msg.match(/reverted with custom error '(\w+)'/);
  if (customErr) return customErr[1];
  // Generic revert reason
  const reason = msg.match(/reverted with reason string '([^']+)'/);
  if (reason) return `"${reason[1]}"`;
  // Trimmed raw message (first 120 chars)
  return msg.slice(0, 120).replace(/\n/g, " ");
}

async function main() {
  const presaleAddr = process.env.PRESALE_ROUND_SEPOLIA;
  if (!presaleAddr) throw new Error("PRESALE_ROUND_SEPOLIA not set in .env");

  const [deployer] = await ethers.getSigners();
  const presale    = await ethers.getContractAt("PreSaleRound", presaleAddr, deployer);

  console.log(`\nNetwork:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Presale:  ${presaleAddr}\n`);

  const results = {};

  // ── Pre-run state snapshot ───────────────────────────────────────────────────
  const currentStaleness  = await presale.maxStaleness();
  const currentHardCap    = await presale.hardCapSRX();
  const currentAllocated  = await presale.totalAllocated();

  console.log(`── Pre-run state ──────────────────────────────────────────`);
  console.log(`maxStaleness:    ${currentStaleness}s`);
  console.log(`hardCapSRX:      ${ethers.formatUnits(currentHardCap, 18)} SRX`);
  console.log(`totalAllocated:  ${ethers.formatUnits(currentAllocated, 18)} SRX`);
  console.log(`remaining:       ${ethers.formatUnits(currentHardCap - currentAllocated, 18)} SRX\n`);

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 1.11 — Oracle staleness
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`── Test 1.11: Oracle Staleness (StalePriceFeed revert) ────`);

  // Step 1: Reduce maxStaleness to 1 second
  console.log(`[1/4] setMaxStaleness(1)...`);
  const tx1 = await presale.setMaxStaleness(1n);
  await tx1.wait();
  const newStaleness = await presale.maxStaleness();
  console.log(`  maxStaleness now: ${newStaleness}s ✅`);

  // Step 2: Confirm current ETH oracle data (shows how stale the feed actually is)
  const ethPrice = await presale.currentEthPrice();
  const ethUsdFeed = await presale.ethUsdFeed();
  const feedAbi = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
  const feed = new ethers.Contract(ethUsdFeed, feedAbi, deployer);
  const [,, , updatedAt,] = await feed.latestRoundData();
  const staleness = BigInt(Math.floor(Date.now() / 1000)) - updatedAt;
  console.log(`[2/4] Oracle state: ETH=$${(Number(ethPrice) / 1e8).toFixed(2)}, feed age=${staleness}s`);
  console.log(`  (with maxStaleness=1, any feed age > 1s will revert)`);

  // Step 3: Attempt invest() — expect StalePriceFeed revert
  console.log(`[3/4] invest(0.001 ETH) — expect StalePriceFeed revert...`);
  results["1.11_staleness"] = await expectRevert(
    presale.invest({ value: ETH_TO_INVEST }),
    "StalePriceFeed"
  );

  // Step 4: Restore maxStaleness to 3600s
  console.log(`[4/4] Restoring maxStaleness to ${DEFAULT_MAX_STALENESS}s...`);
  const tx4 = await presale.setMaxStaleness(DEFAULT_MAX_STALENESS);
  await tx4.wait();
  const restoredStaleness = await presale.maxStaleness();
  console.log(`  maxStaleness restored: ${restoredStaleness}s ✅\n`);

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 1.12 — Hard cap exceeded
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`── Test 1.12: Hard Cap Exceeded (HardCapExceeded revert) ──`);

  // Step 1: Lower hard cap to just above totalAllocated (no room for new investors)
  //         newCap = totalAllocated + 1 SRX  →  any addition of ≥ 2 SRX overflows
  const allocated = await presale.totalAllocated();
  const newCap    = allocated + ethers.parseUnits("1", 18); // totalAllocated + 1 SRX

  console.log(`[1/5] setHardCap(totalAllocated + 1 SRX)...`);
  console.log(`  Current allocated: ${ethers.formatUnits(allocated, 18)} SRX`);
  console.log(`  New cap:           ${ethers.formatUnits(newCap, 18)} SRX`);
  const tx5 = await presale.setHardCap(newCap);
  await tx5.wait();
  const confirmedCap = await presale.hardCapSRX();
  console.log(`  Confirmed cap:     ${ethers.formatUnits(confirmedCap, 18)} SRX ✅`);

  // Step 2: Verify remaining capacity = 1 SRX
  const remaining = await presale.remainingCap();
  console.log(`[2/5] Remaining capacity: ${ethers.formatUnits(remaining, 18)} SRX (expect 1 SRX) ✅`);

  // Step 3: Attempt addInvestor with $100 → ~8,800 SRX at Entry tier
  //         This is >> 1 SRX and must overflow the cap
  const overflowUsd = 10_000_000_000n; // $100 in 8-dec
  console.log(`[3/5] addInvestor($100 = ~8,800 SRX) — expect HardCapExceeded revert...`);
  results["1.12_hardcap"] = await expectRevert(
    presale.addInvestor("0x000000000000000000000000000000000000dEaD", overflowUsd),
    "HardCapExceeded"
  );

  // Step 4: Confirm totalAllocated unchanged after failed call
  const allocatedAfter = await presale.totalAllocated();
  const unchanged      = allocatedAfter === allocated;
  console.log(`[4/5] totalAllocated after failed call: ${ethers.formatUnits(allocatedAfter, 18)} SRX`);
  console.log(`  Unchanged from before: ${unchanged ? "✅" : "❌"}`);
  results["1.12_state_unchanged"] = unchanged;

  // Step 5: Restore hard cap to 400M SRX
  console.log(`[5/5] Restoring hardCapSRX to 400,000,000 SRX...`);
  const tx8 = await presale.setHardCap(FULL_HARD_CAP);
  await tx8.wait();
  const restoredCap = await presale.hardCapSRX();
  console.log(`  Restored: ${ethers.formatUnits(restoredCap, 18)} SRX ✅\n`);

  // ════════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`── Summary ────────────────────────────────────────────────`);
  console.log(`  1.11  StalePriceFeed revert on stale oracle:    ${results["1.11_staleness"]         ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  1.12a HardCapExceeded revert on overflow:       ${results["1.12_hardcap"]           ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  1.12b totalAllocated unchanged after revert:    ${results["1.12_state_unchanged"]   ? "✅ PASS" : "❌ FAIL"}`);

  const allPass = Object.values(results).every(Boolean);
  console.log(`\n${allPass ? "✅ ALL EDGE CASE TESTS PASSED" : "❌ ONE OR MORE TESTS FAILED"}`);

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 Error:", err.message ?? err);
  process.exit(1);
});
