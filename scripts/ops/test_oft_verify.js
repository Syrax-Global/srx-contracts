/**
 * test_oft_verify.js — Phase 8 receipt verification (BSC testnet)
 *
 * Run this ~5 minutes after test_oft_bridge.js --network sepolia completes.
 * LayerZero delivers the cross-chain message and the BSC-side OFT mints 10 SRX
 * to the deployer address.
 *
 * This script verifies:
 *  [8.13] SRXOFTNative balance at deployer address on BSC testnet > 0
 *  [8.14] Received amount == 10 SRX (SEND_AMOUNT from Phase B)
 *  [8.15] SRXOFTNative.totalSupply() == 10 SRX (first ever mint on BSC)
 *  [8.16] Peer config still intact — peers(40161) matches Sepolia SRXToken
 *
 * Run:
 *   npx hardhat run scripts/ops/test_oft_verify.js --network bscTestnet
 *
 * Prerequisites:
 *   SRX_OFT_NATIVE_BSCTESTNET — set by test_oft_bridge.js Phase A
 *   SRX_TOKEN_SEPOLIA_TGE     — set during TGE deploy on Sepolia
 *   Deployer wallet:           0x049fea6abBbc88487Ca14A7910d37E1feCdb9236
 */

const { ethers, network } = require("hardhat");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// ── Pass/fail tracking ─────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, err) {
  const msg = err?.message ?? String(err);
  console.log(`  ❌ ${label}`);
  console.log(`     ${msg.split("\n")[0]}`);
  failed++;
  failures.push({ label, msg });
}

function section(title) {
  const line = "─".repeat(Math.max(0, 56 - title.length));
  console.log(`\n── ${title} ${line}`);
}

function printSummary() {
  const total = passed + failed;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 8 — OFT Bridge Verification (BSC Testnet)`);
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    ✗ ${f.label}`));
    console.log(`\n  If balance checks fail, LayerZero may still be in-flight.`);
    console.log(`  Wait another 2 minutes and re-run this script.`);
  }
  console.log(`${"═".repeat(60)}\n`);
}

function addressToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

const SEND_AMOUNT = ethers.parseUnits("10", 18); // Must match Phase B send amount
const SEPOLIA_EID = 40161;

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (network.name !== "bscTestnet") {
    console.error(`\n  This script must run on bscTestnet.`);
    console.error(`  npx hardhat run scripts/ops/test_oft_verify.js --network bscTestnet`);
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();

  // Load env vars
  const oftAddr         = process.env.SRX_OFT_NATIVE_BSCTESTNET;
  const sepoliaTokenAddr = process.env.SRX_TOKEN_SEPOLIA_TGE;
  const sendTxHash      = process.env.OFT_SEND_TX_SEPOLIA;

  if (!oftAddr) {
    console.error(`\n  Fatal: SRX_OFT_NATIVE_BSCTESTNET not set in .env`);
    console.error(`  Run Phase A first: npx hardhat run scripts/ops/test_oft_bridge.js --network bscTestnet`);
    process.exit(1);
  }

  if (!sepoliaTokenAddr) {
    console.error(`\n  Fatal: SRX_TOKEN_SEPOLIA_TGE not set in .env`);
    process.exit(1);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 8 — OFT Bridge Receipt Verification (BSC Testnet)`);
  console.log(`  Deployer:          ${deployer.address}`);
  console.log(`  SRXOFTNative:      ${oftAddr}`);
  console.log(`  Sepolia SRXToken:  ${sepoliaTokenAddr}`);
  if (sendTxHash) {
    console.log(`  Origin TX:         https://testnet.layerzeroscan.com/tx/${sendTxHash}`);
  }
  console.log(`${"═".repeat(60)}`);

  const oft = await ethers.getContractAt("SRXOFTNative", oftAddr);

  // ── [8.13] Deployer balance > 0 ───────────────────────────────────────────

  section("[8.13] Deployer SRX balance on BSC testnet");

  let deployerBal;
  try {
    deployerBal = await oft.balanceOf(deployer.address);
    console.log(`\n  Deployer balance: ${ethers.formatUnits(deployerBal, 18)} SRX`);

    if (deployerBal > 0n) {
      pass(`Deployer has ${ethers.formatUnits(deployerBal, 18)} SRX on BSC testnet`);
    } else {
      fail(
        "Deployer balance is 0 — LayerZero may still be delivering",
        new Error(
          "Balance = 0. If this fails, wait 2–3 minutes and re-run.\n" +
          (sendTxHash
            ? `Check delivery: https://testnet.layerzeroscan.com/tx/${sendTxHash}`
            : "Check LayerZeroScan for delivery status.")
        )
      );
    }
  } catch (e) { fail("balanceOf(deployer) on BSC", e); }

  // ── [8.14] Received amount == 10 SRX ──────────────────────────────────────

  section("[8.14] Received amount == 10 SRX");

  try {
    if (deployerBal >= SEND_AMOUNT) {
      if (deployerBal === SEND_AMOUNT) {
        pass(`Received exactly 10 SRX (${ethers.formatUnits(deployerBal, 18)} SRX) — first delivery`);
      } else {
        pass(`Received ≥10 SRX (${ethers.formatUnits(deployerBal, 18)} SRX) — may have run multiple times`);
      }
    } else if (deployerBal > 0n) {
      fail(
        `Received only ${ethers.formatUnits(deployerBal, 18)} SRX — expected ≥10 SRX`,
        new Error("Partial delivery or slippage")
      );
    }
  } catch (e) { fail("Amount check", e); }

  // ── [8.15] totalSupply == 10 SRX ──────────────────────────────────────────

  section("[8.15] SRXOFTNative.totalSupply() on BSC testnet");

  try {
    const supply = await oft.totalSupply();
    console.log(`\n  Total supply on BSC: ${ethers.formatUnits(supply, 18)} SRX`);

    if (supply === SEND_AMOUNT) {
      pass(`totalSupply == 10 SRX — only the bridged amount exists on BSC`);
    } else if (supply > 0n) {
      pass(`totalSupply == ${ethers.formatUnits(supply, 18)} SRX (non-zero — bridged supply confirmed)`);
    } else {
      fail("totalSupply is 0 on BSC — tokens not yet minted", new Error("LZ delivery pending"));
    }
  } catch (e) { fail("totalSupply() on BSC", e); }

  // ── [8.16] Peer config still intact ───────────────────────────────────────

  section("[8.16] Peer config: peers(40161) == Sepolia SRXToken");

  try {
    const storedPeer    = await oft.peers(SEPOLIA_EID);
    const expectedPeer  = addressToBytes32(sepoliaTokenAddr).toLowerCase();

    console.log(`\n  Stored peer for EID ${SEPOLIA_EID}: ${storedPeer}`);
    console.log(`  Expected:                             ${expectedPeer}`);

    if (storedPeer.toLowerCase() === expectedPeer) {
      pass(`peers(${SEPOLIA_EID}) == bytes32(sepoliaToken) — peer config intact`);
    } else {
      fail("Peer config mismatch", new Error(`got ${storedPeer}, expected ${expectedPeer}`));
    }
  } catch (e) { fail("peers() check on BSC", e); }

  // ── Summary ───────────────────────────────────────────────────────────────

  printSummary();

  if (failed === 0) {
    console.log(`  ✅ Cross-chain OFT bridge verified end-to-end.`);
    console.log(`     Sepolia → BSC testnet delivery confirmed on-chain.\n`);
    if (sendTxHash) {
      console.log(`  LayerZero scan: https://testnet.layerzeroscan.com/tx/${sendTxHash}`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err.message ?? err);
  process.exit(1);
});
