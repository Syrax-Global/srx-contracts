/**
 * Step 7 — Deploy Bridge (SRXOFTNative on remote chains + wire peers)
 *
 * Architecture — HUB AND SPOKE (Jared, 23 Sep 2026; pre-external-audit sweep N-01):
 *  - Ethereum (SRXToken) is the hub. It burns on send, mints on receive, and
 *    records how much it has sent to each chain (outstandingByEid). It will
 *    re-credit a chain only up to that amount.
 *  - Each remote chain (SRXOFTNative) is a spoke. It sends to, and accepts from,
 *    the hub ONLY — hubEid is fixed at deployment and enforced on every send and
 *    receive. Spoke-to-spoke is two hops through Ethereum.
 *
 * ⛔ Previously every chain was peered to every other, and the peer list mixed
 *    testnet and mainnet entries, so a mainnet chain would have trusted a testnet
 *    contract whenever that variable happened to be set. The two environments are
 *    now separate lists, and a spoke is only ever peered to its own hub.
 *
 * Step A: run on each remote chain to deploy SRXOFTNative.
 *   npx hardhat run scripts/deploy/07_deploy_bridge.js --network bscTestnet
 * Step B: run on the hub with SET_PEERS=true to peer it to every spoke.
 *   SET_PEERS=true npx hardhat run scripts/deploy/07_deploy_bridge.js --network sepolia
 * Step C: run on each spoke with SET_PEERS=true to peer it to the hub.
 *   SET_PEERS=true npx hardhat run scripts/deploy/07_deploy_bridge.js --network bscTestnet
 *
 * Step D: run on each spoke with HANDOVER=true. The Safe makes the spoke's own Timelock
 *   its LayerZero delegate, starts the ownership transfer, and schedules the Timelock's
 *   acceptance (SPOKE-01).
 *   HANDOVER=true npx hardhat run scripts/deploy/07_deploy_bridge.js --network bscTestnet
 * Step E: after the Timelock delay, run on each spoke with FINALIZE=true (anyone may).
 *   FINALIZE=true npx hardhat run scripts/deploy/07_deploy_bridge.js --network bscTestnet
 * Then scripts/verify/verify_spoke.js on each spoke must pass.
 *
 * ⭐ External disclosure A (reported 3 Oct 2026; Jared 7 Oct, full fix):
 *  - every spoke is deployed with the hub's address, and accepts no other peer;
 *  - its owner and LayerZero delegate are its own 48-hour Timelock (steps D and E);
 *  - the hub accepts returns from each spoke only up to a limit (a draining bucket: at most
 *    that much in flight, refilling at that amount per 24 hours), which step B sets
 *    (BRIDGE.inboundLimitPerDay in 00_config.js). With no limit set, the hub refuses
 *    every return from that spoke.
 *
 * DVNs (THREAT_MODEL: at least 2): SET_DVNS=true sets this chain's own send and receive
 * libraries and a ULN config needing every operator in BRIDGE.dvns to agree, for each
 * peer pathway. The LayerZero defaults (one DVN) are not accepted; verify_roles and
 * verify_spoke refuse them. The caller must be the OApp's delegate: on a spoke, run it
 * BEFORE step D, or afterwards as a spoke Timelock proposal.
 */
const { ethers, network } = require("hardhat");
const { LZ_ENDPOINTS, LZ_EIDS, WALLETS, GOVERNANCE, BRIDGE } = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");
const { deploySpokeTimelock, handoverSpoke, finalizeSpoke } = require("./lib/spokeOps");
const { lzReceiveOption } = require("./lib/dvnCheck");
const { environmentOf } = require("./lib/bridgeEnv");

function addressToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

// One hub per environment, and the spokes it may be peered to: lib/bridgeEnv.js (shared with
// verify_roles.js, which fails a hub peer on any chain not listed there).

async function deployNative() {
  const { e } = environmentOf(network.name);
  console.log(`\nDeploying SRXOFTNative on ${network.name} (hub EID ${e.hub.eid}, ${e.hub.network})`);

  const lzEndpoint = LZ_ENDPOINTS[network.name];
  if (!lzEndpoint) throw new Error(`No LZ endpoint for ${network.name}`);

  // The hub's address is fixed into the spoke at deployment: it is the only peer the
  // spoke will ever accept (disclosure A).
  const hubAddress = process.env[e.hub.env];
  if (!hubAddress) throw new Error(`${e.hub.env} is not set — the spoke needs the hub token's address at deployment`);

  const admin = WALLETS.admin;
  const [deployer] = await ethers.getSigners();
  const SRXOFTNative = await ethers.getContractFactory("SRXOFTNative");
  const oft = await SRXOFTNative.deploy(lzEndpoint, admin, e.hub.eid, ethers.getAddress(hubAddress));
  await oft.waitForDeployment();

  const address = await oft.getAddress();
  if ((await oft.hubEid()) !== BigInt(e.hub.eid)) throw new Error("hubEid was not set as deployed");
  console.log(`SRXOFTNative deployed on ${network.name}: ${address} (hub ${hubAddress})`);

  // SPOKE-01: this spoke's own Timelock. The Safe proposes; anyone executes; no admin.
  const minDelay = GOVERNANCE.timelockDelayFor(network.name);
  const timelock = await deploySpokeTimelock({ deployer, safe: admin, minDelay });
  const tlAddress = await timelock.getAddress();
  console.log(`Spoke SRXTimelock deployed on ${network.name}: ${tlAddress} (delay ${minDelay}s)`);

  console.log(`\n⚠️  Save to .env:`);
  console.log(`SRX_OFT_NATIVE_${network.name.toUpperCase()}=${address}`);
  console.log(`SPOKE_TIMELOCK_${network.name.toUpperCase()}=${tlAddress}`);
  return address;
}

/** SET_DVNS=true: own libraries and an all-operators-must-agree ULN config, per pathway. */
async function setDvns() {
  const { e, role } = environmentOf(network.name);
  const mine = BRIDGE.dvns[network.name];
  if (!mine) throw new Error(`No DVN configuration for ${network.name} in BRIDGE.dvns (00_config.js); choosing mainnet operators is Jared's decision`);
  const self = role === "hub" ? e.hub : e.spokes.find((s) => s.network === network.name);
  const oapp = process.env[self.env];
  if (!oapp) throw new Error(`${self.env} is not set`);
  const endpoint = new ethers.Contract(LZ_ENDPOINTS[network.name], [
    "function setSendLibrary(address oapp, uint32 eid, address newLib)",
    "function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod)",
    "function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params)",
  ], ethers.provider);
  const ULN = "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)";
  // The ULN requires the DVN list sorted ascending with no duplicates.
  const sorted = (ops) => Object.values(ops).map(ethers.getAddress).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const uln = (confirmations, dvns) => ethers.AbiCoder.defaultAbiCoder().encode([ULN], [[confirmations, dvns.length, 0, 0, dvns, []]]);

  const batch = createAdminBatch("07_dvns");
  const peers = role === "hub" ? e.spokes : [e.hub];
  for (const peer of peers) {
    const theirs = BRIDGE.dvns[peer.network];
    if (!theirs || !process.env[peer.env]) { console.warn(`⚠️  ${peer.network}: not deployed or no DVN config — skipped`); continue; }
    if (Object.keys(theirs.operators).join() !== Object.keys(mine.operators).join()) {
      throw new Error(`${network.name} and ${peer.network} list different DVN operators; both ends of a pathway must agree`);
    }
    const dvns = sorted(mine.operators);
    console.log(`DVNs ${network.name} <-> ${peer.network}: ${Object.keys(mine.operators).join(" + ")} (${dvns.length} must agree)`);
    await batch.send(endpoint, "setSendLibrary", [oapp, peer.eid, mine.sendLib], `setSendLibrary(${peer.network})`);
    await batch.send(endpoint, "setReceiveLibrary", [oapp, peer.eid, mine.receiveLib, 0], `setReceiveLibrary(${peer.network})`);
    await batch.send(endpoint, "setConfig", [oapp, mine.sendLib, [{ eid: peer.eid, configType: 2, config: uln(mine.confirmations, dvns) }]],
      `send ULN config to ${peer.network}: ${dvns.length} DVNs, ${mine.confirmations} confirmations`);
    await batch.send(endpoint, "setConfig", [oapp, mine.receiveLib, [{ eid: peer.eid, configType: 2, config: uln(theirs.confirmations, dvns) }]],
      `receive ULN config from ${peer.network}: ${dvns.length} DVNs, ${theirs.confirmations} confirmations`);
  }
  await batch.flush();
}

async function setPeers() {
  const { e, role } = environmentOf(network.name);
  console.log(`\nSetting LayerZero peers on ${network.name} (${role})`);

  const self = role === "hub" ? e.hub : e.spokes.find((s) => s.network === network.name);
  const tokenAddress = process.env[self.env];
  if (!tokenAddress) throw new Error(`${self.env} is not set`);
  const token = await ethers.getContractAt(role === "hub" ? "SRXToken" : "SRXOFTNative", tokenAddress);

  // The hub peers every spoke of its own environment; a spoke peers its hub only.
  // setPeer is onlyOwner, and the owner is WALLETS.admin (Ownable(_admin) in the
  // constructor) — not the deployer. SC-TRUST-002: route through the admin Safe.
  const batch = createAdminBatch("07_bridge");
  const peers = role === "hub" ? e.spokes : [e.hub];
  let missing = 0;
  for (const peer of peers) {
    const peerAddress = process.env[peer.env];
    if (!peerAddress) { console.warn(`⚠️  ${peer.env} not set — ${peer.network} NOT peered`); missing++; continue; }
    console.log(`Setting peer: EID ${peer.eid} (${peer.network}) → ${peerAddress}`);
    await batch.send(token, "setPeer", [peer.eid, addressToBytes32(peerAddress)], `setPeer(EID ${peer.eid}, ${peer.network} → ${peerAddress})`);
    // Delivery gas for every transfer on this pathway (BRIDGE.lzReceiveGas): without it a
    // send with empty options reverts at the quote.
    await batch.send(token, "setEnforcedOptions", [[{ eid: peer.eid, msgType: 1, options: lzReceiveOption(BRIDGE.lzReceiveGas) }]],
      `setEnforcedOptions(EID ${peer.eid}, SEND: ${BRIDGE.lzReceiveGas} gas)`);
  }
  // The hub accepts returns from each spoke only up to a limit, a draining bucket that
  // refills at that amount per 24 hours (disclosure A).
  if (role === "hub") {
    const { name } = environmentOf(network.name);
    const limit = BRIDGE.inboundLimitPerDay[name];
    if (limit === null || limit === undefined) {
      console.warn(`⚠️  No daily return limit is configured for ${name} (BRIDGE.inboundLimitPerDay). The hub refuses every`);
      console.warn(`    return until one is set. Setting it is a decision for Jared; record it in 00_config.js.`);
    } else {
      for (const peer of peers) {
        if (!process.env[peer.env]) continue;
        console.log(`Daily return limit: EID ${peer.eid} (${peer.network}) → ${ethers.formatUnits(limit, 18)} SRX`);
        await batch.send(token, "setInboundLimit", [peer.eid, limit], `setInboundLimit(EID ${peer.eid}, ${ethers.formatUnits(limit, 18)} SRX per day)`);
      }
    }
  }
  await batch.flush();
  console.log(`\n${missing ? "⚠️  Partially" : "✅"} peered on ${network.name}`);
}

function spokeContracts() {
  const NET = network.name.toUpperCase();
  const s = process.env[`SRX_OFT_NATIVE_${NET}`], t = process.env[`SPOKE_TIMELOCK_${NET}`];
  if (!s || !t) throw new Error(`SRX_OFT_NATIVE_${NET} and SPOKE_TIMELOCK_${NET} must be set`);
  return Promise.all([ethers.getContractAt("SRXOFTNative", s), ethers.getContractAt("SRXTimelock", t)]);
}

/** Step D (SPOKE-01): the Safe hands the spoke's owner and delegate to the spoke Timelock. */
async function handover() {
  const [spoke, timelock] = await spokeContracts();
  const batch = createAdminBatch("07_spoke_handover");
  await handoverSpoke({ spoke, timelock, send: (c, fn, args, d) => batch.send(c, fn, args, d) });
  const wrote = await batch.flush();
  console.log(wrote ? `\n📝 The Safe on ${network.name} must execute ${wrote}, then wait the Timelock delay and run FINALIZE=true.`
                    : `\n✅ Hand-over sent on ${network.name}. After the Timelock delay, run FINALIZE=true.`);
}

/** Step E: execute the spoke Timelock's acceptance of ownership (open to anyone). */
async function finalize() {
  const [spoke, timelock] = await spokeContracts();
  const [signer] = await ethers.getSigners();
  const done = await finalizeSpoke({ spoke, timelock, signer });
  console.log(done ? `✅ The spoke Timelock now owns SRXOFTNative on ${network.name}. Run verify_spoke.js.`
                   : `  ✓ (already done) the spoke Timelock owns SRXOFTNative on ${network.name}`);
}

async function main() {
  const { role } = environmentOf(network.name);
  if (process.env.HANDOVER === "true" || process.env.FINALIZE === "true") {
    if (role !== "spoke") throw new Error("HANDOVER and FINALIZE apply to spoke chains only");
    if (process.env.HANDOVER === "true") await handover();
    if (process.env.FINALIZE === "true") await finalize();
    return;
  }
  if (process.env.SET_DVNS === "true") { await setDvns(); return; }
  if (role === "spoke" && process.env.SET_PEERS !== "true") await deployNative();

  if (process.env.SET_PEERS === "true") {
    await setPeers();
  } else {
    console.log(`\nTo wire peers, re-run with SET_PEERS=true after every contract in this environment is deployed.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
