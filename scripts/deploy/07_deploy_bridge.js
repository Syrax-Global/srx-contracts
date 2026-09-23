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
 * Still manual and required before mainnet (THREAT_MODEL: ≥ 2 DVNs): the send/receive
 * library and DVN configuration (endpoint setConfig) on every chain. The LayerZero
 * defaults are not an accepted configuration.
 */
const { ethers, network } = require("hardhat");
const { LZ_ENDPOINTS, LZ_EIDS, WALLETS } = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");

function addressToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

// One hub per environment. A network belongs to exactly one environment.
const ENVIRONMENTS = {
  testnet: {
    hub:    { network: "sepolia",  env: "SRX_TOKEN_SEPOLIA",  eid: LZ_EIDS.sepolia },
    spokes: [
      { network: "bscTestnet",    env: "SRX_OFT_NATIVE_BSCTESTNET",    eid: LZ_EIDS.bscTestnet },
      { network: "zkSyncSepolia", env: "SRX_OFT_NATIVE_ZKSYNCSEPOLIA", eid: LZ_EIDS.zkSyncSepolia },
    ],
  },
  mainnet: {
    hub:    { network: "ethereum", env: "SRX_TOKEN_ETHEREUM", eid: LZ_EIDS.ethereum },
    spokes: [
      { network: "bsc",    env: "SRX_OFT_NATIVE_BSC",    eid: LZ_EIDS.bsc },
      { network: "zkSync", env: "SRX_OFT_NATIVE_ZKSYNC", eid: LZ_EIDS.zkSync },
    ],
  },
};

function environmentOf(networkName) {
  for (const [name, e] of Object.entries(ENVIRONMENTS)) {
    if (e.hub.network === networkName) return { name, e, role: "hub" };
    const spoke = e.spokes.find((s) => s.network === networkName);
    if (spoke) return { name, e, role: "spoke", spoke };
  }
  throw new Error(`${networkName} is not a hub or spoke in any bridge environment`);
}

async function deployNative() {
  const { e } = environmentOf(network.name);
  console.log(`\nDeploying SRXOFTNative on ${network.name} (hub EID ${e.hub.eid}, ${e.hub.network})`);

  const lzEndpoint = LZ_ENDPOINTS[network.name];
  if (!lzEndpoint) throw new Error(`No LZ endpoint for ${network.name}`);

  const admin = WALLETS.admin;
  const SRXOFTNative = await ethers.getContractFactory("SRXOFTNative");
  const oft = await SRXOFTNative.deploy(lzEndpoint, admin, e.hub.eid);
  await oft.waitForDeployment();

  const address = await oft.getAddress();
  if ((await oft.hubEid()) !== BigInt(e.hub.eid)) throw new Error("hubEid was not set as deployed");
  console.log(`SRXOFTNative deployed on ${network.name}: ${address}`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`SRX_OFT_NATIVE_${network.name.toUpperCase()}=${address}`);
  return address;
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
  }
  await batch.flush();
  console.log(`\n${missing ? "⚠️  Partially" : "✅"} peered on ${network.name}`);
}

async function main() {
  const { role } = environmentOf(network.name);
  if (role === "spoke") await deployNative();

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
