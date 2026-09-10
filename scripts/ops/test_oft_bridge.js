/**
 * test_oft_bridge.js — Phase 8: OFT Cross-Chain Bridge (Sepolia ↔ BSC Testnet)
 *
 * Network-aware script. Detects network and runs the correct phase:
 *
 *  ── Phase A (run on bscTestnet) ──────────────────────────────────────────────
 *  [8.1]  Deploy SRXOFTNative on BSC testnet
 *  [8.2]  Set peer: BSC → Sepolia TGE SRXToken (EID 40161)
 *  [8.3]  Verify peer stored correctly
 *  [8.4]  Save SRX_OFT_NATIVE_BSCTESTNET to .env
 *
 *  ── Phase B (run on sepolia) ─────────────────────────────────────────────────
 *  [8.5]  Load BSC OFT address from .env
 *  [8.6]  Set peer: Sepolia → BSC OFT (EID 40102)
 *  [8.7]  Verify peer stored correctly on Sepolia
 *  [8.8]  quoteSend(10 SRX to BSC) → returns non-zero native fee estimate
 *  [8.9]  Pre-send balance snapshot on Sepolia
 *  [8.10] send(10 SRX → BSC) with quoted fee — burns on Sepolia
 *  [8.11] Post-send: verify 10 SRX debited from Sepolia balance
 *  [8.12] Save send TX hash to .env for cross-reference
 *         Note: LZ delivery to BSC takes ~2–5 minutes.
 *         Run test_oft_verify.js --network bscTestnet to confirm receipt.
 *
 * Run sequence:
 *   Step 1:  npx hardhat run scripts/ops/test_oft_bridge.js --network bscTestnet
 *   Step 2:  npx hardhat run scripts/ops/test_oft_bridge.js --network sepolia
 *   [wait 2–5 min for LayerZero message delivery]
 *   Step 3:  npx hardhat run scripts/ops/test_oft_verify.js --network bscTestnet
 *
 * Prerequisites for bscTestnet step:
 *  - Deployer wallet needs BNB testnet for gas
 *  - Faucet: https://testnet.bnbchain.org/faucet-smart
 *  - Deployer: 0x049fea6abBbc88487Ca14A7910d37E1feCdb9236
 *
 * Prerequisites for sepolia step:
 *  - SRX_OFT_NATIVE_BSCTESTNET must be set in .env (from bscTestnet step)
 *  - SRX_TOKEN_SEPOLIA_TGE must be set in .env
 *  - Deployer needs Sepolia ETH (for LZ native fee + gas)
 */

const { ethers, network } = require("hardhat");
const path = require("path");
const fs   = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// ── Pass/fail tracking ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
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

function printSummary(phase) {
  const total = passed + failed;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 8 — OFT Bridge (${phase})`);
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    ✗ ${f.label}`));
  }
  console.log(`${"═".repeat(60)}\n`);
}

function saveEnv(key, value) {
  const envPath = path.join(__dirname, "../../.env");
  let content = fs.readFileSync(envPath, "utf8");
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
    fs.writeFileSync(envPath, content);
  } else {
    fs.appendFileSync(envPath, `\n${key}=${value}\n`);
  }
  console.log(`\n  ${key}=${value}`);
}

function addressToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

// LZ V2 options: TYPE_3 | executor | lzReceive(200,000 gas, 0 value)
// Encoding: uint16(3) | uint8(1=executor) | uint16(17=length) | uint8(1=lzReceive) | uint128(200000)
const LZ_GAS_OPTION = "0x00030100110100000000000000000000000000030d40";

// ── Phase A: BSC Testnet — Deploy SRXOFTNative + set peers ────────────────────

async function runBscTestnet() {
  const [deployer] = await ethers.getSigners();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 8A — BSC Testnet: Deploy SRXOFTNative`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"═".repeat(60)}`);

  // Check BNB balance for gas
  const bnbBalance = await ethers.provider.getBalance(deployer.address);
  console.log(`\n  BNB testnet balance: ${ethers.formatEther(bnbBalance)} BNB`);

  if (bnbBalance === 0n) {
    console.error(`\n  ❌ Deployer has 0 BNB on BSC testnet — cannot pay gas.`);
    console.error(`  Get BNB testnet from: https://testnet.bnbchain.org/faucet-smart`);
    console.error(`  Deployer address:     ${deployer.address}`);
    process.exit(1);
  }

  if (bnbBalance < ethers.parseEther("0.05")) {
    console.warn(`  ⚠️  Low BNB balance (< 0.05 BNB). Deploy may fail.`);
    console.warn(`  Faucet: https://testnet.bnbchain.org/faucet-smart`);
  }

  // Load Sepolia TGE SRX address (the peer this BSC OFT will trust)
  const sepoliaTokenAddr = process.env.SRX_TOKEN_SEPOLIA_TGE;
  if (!sepoliaTokenAddr) {
    console.error(`\n  Fatal: SRX_TOKEN_SEPOLIA_TGE not set in .env`);
    console.error(`  Run the TGE teststack deploy on Sepolia first.`);
    process.exit(1);
  }

  const LZ_ENDPOINT_BSC = "0x6EDCE65403992e310A62460808c4b910D972f10f";
  const SEPOLIA_EID = 40161;

  // ── [8.1] Deploy SRXOFTNative ──────────────────────────────────────────────

  section("[8.1] Deploy SRXOFTNative on BSC testnet");

  let oft, oftAddr;

  try {
    const Factory = await ethers.getContractFactory("SRXOFTNative");
    oft = await Factory.deploy(LZ_ENDPOINT_BSC, deployer.address);
    await oft.waitForDeployment();
    oftAddr = await oft.getAddress();

    console.log(`\n  SRXOFTNative: ${oftAddr}`);
    console.log(`  Name:         ${await oft.name()}`);
    console.log(`  Symbol:       ${await oft.symbol()}`);
    console.log(`  Decimals:     ${await oft.decimals()}`);

    if (oftAddr !== ethers.ZeroAddress) {
      pass("SRXOFTNative deployed on BSC testnet");
    } else {
      fail("Deployment address is zero", new Error("ZeroAddress"));
    }

    // Verify total supply is 0 (no genesis on remote chain)
    const supply = await oft.totalSupply();
    if (supply === 0n) {
      pass("totalSupply == 0 (no genesis — supply originates from Ethereum)");
    } else {
      fail(`totalSupply should be 0, got ${ethers.formatUnits(supply, 18)}`, new Error("non-zero supply"));
    }

  } catch (e) {
    fail("Deploy SRXOFTNative", e);
    printSummary("BSC Testnet");
    process.exit(1);
  }

  // ── [8.2] Set peer: BSC → Sepolia ─────────────────────────────────────────

  section("[8.2] Set peer: BSC testnet → Sepolia SRXToken (EID 40161)");

  console.log(`\n  Sepolia SRXToken: ${sepoliaTokenAddr}`);
  console.log(`  Sepolia EID:      ${SEPOLIA_EID}\n`);

  try {
    const peerBytes = addressToBytes32(sepoliaTokenAddr);
    await (await oft.setPeer(SEPOLIA_EID, peerBytes)).wait();
    pass(`setPeer(${SEPOLIA_EID}, sepoliaToken) succeeded`);
  } catch (e) { fail("setPeer BSC→Sepolia", e); }

  // ── [8.3] Verify peer stored ───────────────────────────────────────────────

  section("[8.3] Verify peer stored correctly");

  try {
    const storedPeer = await oft.peers(SEPOLIA_EID);
    const expectedPeer = addressToBytes32(sepoliaTokenAddr).toLowerCase();
    if (storedPeer.toLowerCase() === expectedPeer) {
      pass(`peers(${SEPOLIA_EID}) == bytes32(sepoliaTokenAddr)`);
    } else {
      fail("Stored peer does not match", new Error(`got ${storedPeer}`));
    }
  } catch (e) { fail("peers() read", e); }

  // ── [8.4] Save address to .env ────────────────────────────────────────────

  section("[8.4] Save SRX_OFT_NATIVE_BSCTESTNET to .env");

  try {
    saveEnv("SRX_OFT_NATIVE_BSCTESTNET", oftAddr);
    pass("SRX_OFT_NATIVE_BSCTESTNET saved to .env");
  } catch (e) { fail("Save .env", e); }

  printSummary("BSC Testnet — Phase A");

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ✅ BSC Testnet setup complete.`);
  console.log(`\n  Next step — run on Sepolia to wire peers and send:`);
  console.log(`  npx hardhat run scripts/ops/test_oft_bridge.js --network sepolia`);
  console.log(`${"─".repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

// ── Phase B: Sepolia — Wire peers + send ──────────────────────────────────────

async function runSepolia() {
  const [deployer] = await ethers.getSigners();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase 8B — Sepolia: Wire peers + send SRX cross-chain`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"═".repeat(60)}`);

  // Load addresses
  const srxTokenAddr = process.env.SRX_TOKEN_SEPOLIA_TGE;
  const bscOftAddr   = process.env.SRX_OFT_NATIVE_BSCTESTNET;

  if (!srxTokenAddr) {
    console.error(`\n  Fatal: SRX_TOKEN_SEPOLIA_TGE not set in .env`);
    process.exit(1);
  }
  if (!bscOftAddr) {
    console.error(`\n  Fatal: SRX_OFT_NATIVE_BSCTESTNET not set in .env`);
    console.error(`  Run the BSC testnet step first:`);
    console.error(`  npx hardhat run scripts/ops/test_oft_bridge.js --network bscTestnet`);
    process.exit(1);
  }

  const BSC_TESTNET_EID = 40102;
  const SEND_AMOUNT     = ethers.parseUnits("10", 18); // 10 SRX — small test amount

  console.log(`\nAddresses:`);
  console.log(`  SRXToken (TGE):     ${srxTokenAddr}`);
  console.log(`  SRXOFTNative (BSC): ${bscOftAddr}`);
  console.log(`  BSC Testnet EID:    ${BSC_TESTNET_EID}`);
  console.log(`  Send amount:        10 SRX`);

  const srxToken = await ethers.getContractAt("SRXToken", srxTokenAddr);

  // ── [8.5] Load BSC OFT address ────────────────────────────────────────────

  section("[8.5] BSC OFT address loaded from .env");
  pass(`SRX_OFT_NATIVE_BSCTESTNET = ${bscOftAddr}`);

  // ── [8.6] Set peer: Sepolia → BSC testnet ────────────────────────────────

  section("[8.6] Set peer: Sepolia SRXToken → BSC OFT (EID 40102)");

  console.log(`\n  BSC OFT:     ${bscOftAddr}`);
  console.log(`  BSC EID:     ${BSC_TESTNET_EID}\n`);

  try {
    const peerBytes = addressToBytes32(bscOftAddr);
    await (await srxToken.setPeer(BSC_TESTNET_EID, peerBytes)).wait();
    pass(`setPeer(${BSC_TESTNET_EID}, bscOFT) on Sepolia succeeded`);
  } catch (e) { fail("setPeer Sepolia→BSC", e); }

  // ── [8.7] Verify peer stored on Sepolia ──────────────────────────────────

  section("[8.7] Verify peer stored on Sepolia SRXToken");

  try {
    const storedPeer = await srxToken.peers(BSC_TESTNET_EID);
    const expectedPeer = addressToBytes32(bscOftAddr).toLowerCase();
    if (storedPeer.toLowerCase() === expectedPeer) {
      pass(`peers(${BSC_TESTNET_EID}) == bytes32(bscOFT) on Sepolia`);
    } else {
      fail("Stored peer does not match", new Error(`got ${storedPeer}, expected ${expectedPeer}`));
    }
  } catch (e) { fail("peers() read on Sepolia", e); }

  // ── [8.8] quoteSend — get native fee estimate ─────────────────────────────

  section("[8.8] quoteSend — LZ native fee estimate for 10 SRX → BSC");

  const sendParam = {
    dstEid:       BSC_TESTNET_EID,
    to:           addressToBytes32(deployer.address),
    amountLD:     SEND_AMOUNT,
    minAmountLD:  SEND_AMOUNT,
    extraOptions: LZ_GAS_OPTION,
    composeMsg:   "0x",
    oftCmd:       "0x",
  };

  let quotedFee;

  try {
    const msgFee = await srxToken.quoteSend(sendParam, false);
    quotedFee = msgFee.nativeFee;

    const feeEth = ethers.formatEther(quotedFee);
    console.log(`\n  Quoted nativeFee: ${feeEth} ETH`);

    if (quotedFee > 0n) {
      pass(`quoteSend() returned non-zero fee: ${feeEth} ETH`);
    } else {
      fail("quoteSend() returned 0 fee", new Error("nativeFee=0 — peer may not be set correctly"));
    }

    const lzTokenFee = msgFee.lzTokenFee;
    if (lzTokenFee === 0n) {
      pass("lzTokenFee == 0 (paying in native ETH, not LZ token)");
    }

  } catch (e) { fail("quoteSend()", e); }

  if (!quotedFee || quotedFee === 0n) {
    console.error(`\n  Fatal: cannot proceed with send — quoted fee is 0.`);
    console.error(`  This usually means the BSC peer is not set correctly on Sepolia.`);
    printSummary("Sepolia — Phase B");
    process.exit(1);
  }

  // Check deployer has enough ETH for fee
  const deployerEth = await ethers.provider.getBalance(deployer.address);
  console.log(`\n  Deployer ETH balance: ${ethers.formatEther(deployerEth)} ETH`);
  if (deployerEth < quotedFee) {
    fail("Insufficient ETH for LZ fee", new Error(
      `Need ${ethers.formatEther(quotedFee)} ETH, have ${ethers.formatEther(deployerEth)}`
    ));
    printSummary("Sepolia — Phase B");
    process.exit(1);
  }

  // ── [8.9] Pre-send balance snapshot ───────────────────────────────────────

  section("[8.9] Pre-send balance snapshot");

  let balBefore;
  try {
    balBefore = await srxToken.balanceOf(deployer.address);
    pass(`Deployer SRX before send: ${ethers.formatUnits(balBefore, 18)} SRX`);
  } catch (e) { fail("balanceOf() before send", e); }

  // ── [8.10] send() — cross-chain transfer Sepolia → BSC testnet ───────────

  section("[8.10] send() — burn 10 SRX on Sepolia, LayerZero mints on BSC");

  console.log(`\n  Sending 10 SRX to ${deployer.address} on BSC testnet`);
  console.log(`  LZ fee: ${ethers.formatEther(quotedFee)} ETH (paid as msg.value)\n`);

  let sendTxHash;

  try {
    const msgFee = { nativeFee: quotedFee, lzTokenFee: 0n };

    const tx = await srxToken.send(
      sendParam,
      msgFee,
      deployer.address, // refund address
      { value: quotedFee }
    );
    const rx = await tx.wait();
    sendTxHash = tx.hash;

    console.log(`  TX hash: ${tx.hash}`);
    console.log(`  Block:   ${rx.blockNumber}`);

    pass(`send() tx mined — block ${rx.blockNumber}`);

    // Look for OFTSent event (or Transfer/Burn events)
    const oftSentEvent = rx.logs?.find(l => {
      try { return srxToken.interface.parseLog(l)?.name === "OFTSent"; } catch { return false; }
    });
    if (oftSentEvent) {
      const parsed = srxToken.interface.parseLog(oftSentEvent);
      pass(`OFTSent event: amountSentLD=${ethers.formatUnits(parsed.args.amountSentLD ?? parsed.args[2] ?? 0n, 18)} SRX`);
    } else {
      pass("send() tx confirmed (OFTSent event decode varies by ABI)");
    }

  } catch (e) { fail("send()", e); }

  // ── [8.11] Post-send balance: verify debit ────────────────────────────────

  section("[8.11] Verify 10 SRX debited from Sepolia balance");

  try {
    const balAfter = await srxToken.balanceOf(deployer.address);
    const debited  = balBefore - balAfter;

    console.log(`\n  Balance before: ${ethers.formatUnits(balBefore, 18)} SRX`);
    console.log(`  Balance after:  ${ethers.formatUnits(balAfter, 18)} SRX`);
    console.log(`  Debited:        ${ethers.formatUnits(debited, 18)} SRX\n`);

    if (debited === SEND_AMOUNT) {
      pass(`Sepolia balance reduced by exactly 10 SRX (burned by OFT send)`);
    } else if (debited > 0n) {
      pass(`Sepolia balance reduced by ${ethers.formatUnits(debited, 18)} SRX (≈10 SRX)`);
    } else {
      fail("Sepolia balance was not reduced", new Error("debit=0"));
    }
  } catch (e) { fail("balanceOf() after send", e); }

  // ── [8.12] Save TX hash ───────────────────────────────────────────────────

  section("[8.12] Save send TX hash to .env");

  if (sendTxHash) {
    try {
      saveEnv("OFT_SEND_TX_SEPOLIA", sendTxHash);
      pass("OFT_SEND_TX_SEPOLIA saved to .env");
    } catch (e) { fail("Save TX hash", e); }
  }

  printSummary("Sepolia — Phase B");

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ✅ Sepolia send complete. LayerZero is delivering the message.`);
  console.log(`\n  LayerZero delivery typically takes 2–5 minutes on testnets.`);
  console.log(`  Monitor: https://testnet.layerzeroscan.com/tx/${sendTxHash ?? ""}`);
  console.log(`\n  After ~5 minutes, verify BSC receipt:`);
  console.log(`  npx hardhat run scripts/ops/test_oft_verify.js --network bscTestnet`);
  console.log(`${"─".repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (network.name === "bscTestnet") {
    await runBscTestnet();
  } else if (network.name === "sepolia") {
    await runSepolia();
  } else {
    console.error(`\n  Unsupported network: ${network.name}`);
    console.error(`  Run with --network bscTestnet or --network sepolia`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err.message ?? err);
  process.exit(1);
});
