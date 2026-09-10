/**
 * Step 7 — Deploy Bridge (SRXOFTNative on remote chains + wire peers)
 *
 * Deploy SRXOFTNative on each remote chain (BSC, zkSync), then wire the
 * LayerZero peer relationships so cross-chain transfers work.
 *
 * Architecture:
 *  - Ethereum (SRXToken / OFT origin): burn on send, mint on receive.
 *  - BSC / zkSync (SRXOFTNative): burn on send, mint on receive.
 *  - All chains trust each other as peers via LayerZero peer registry.
 *
 * Step A: Run on each remote chain to deploy SRXOFTNative.
 * Step B: Run on Ethereum to set peers (add all remote chain OFT addresses).
 * Step C: Run on each remote chain to set peers (Ethereum + other remotes).
 *
 * Run Step A: npx hardhat run scripts/deploy/07_deploy_bridge.js --network bscTestnet
 * Run Step B: npx hardhat run scripts/deploy/07_deploy_bridge.js --network sepolia (set peers)
 */
const { ethers, network } = require("hardhat");
const { LZ_ENDPOINTS, LZ_EIDS, WALLETS } = require("./00_config");

function addressToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

async function deployNative() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying SRXOFTNative on ${network.name}`);

  const lzEndpoint = LZ_ENDPOINTS[network.name];
  if (!lzEndpoint) throw new Error(`No LZ endpoint for ${network.name}`);

  const admin = WALLETS.admin;
  const SRXOFTNative = await ethers.getContractFactory("SRXOFTNative");
  const oft = await SRXOFTNative.deploy(lzEndpoint, admin);
  await oft.waitForDeployment();

  const address = await oft.getAddress();
  console.log(`SRXOFTNative deployed on ${network.name}: ${address}`);
  console.log(`\n⚠️  Save to .env:`);
  console.log(`SRX_OFT_NATIVE_${network.name.toUpperCase()}=${address}`);

  return address;
}

async function setPeers() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nSetting LayerZero peers on ${network.name}`);

  let tokenAddress;
  let contractFactory;

  if (network.name === "sepolia" || network.name === "ethereum") {
    tokenAddress = process.env[`SRX_TOKEN_${network.name.toUpperCase()}`];
    contractFactory = "SRXToken";
  } else {
    tokenAddress = process.env[`SRX_OFT_NATIVE_${network.name.toUpperCase()}`];
    contractFactory = "SRXOFTNative";
  }

  if (!tokenAddress) throw new Error(`Token address not set for ${network.name}`);

  const token = await ethers.getContractAt(contractFactory, tokenAddress);

  // Peer configurations — add each remote chain the current chain should trust
  const peerConfigs = [
    { env: "SRX_TOKEN_SEPOLIA",            eid: LZ_EIDS.sepolia },
    { env: "SRX_TOKEN_ETHEREUM",           eid: LZ_EIDS.ethereum },
    { env: "SRX_OFT_NATIVE_BSCTESTNET",   eid: LZ_EIDS.bscTestnet },
    { env: "SRX_OFT_NATIVE_BSC",          eid: LZ_EIDS.bsc },
    { env: "SRX_OFT_NATIVE_ZKSYNCSEPOLIA",  eid: LZ_EIDS.zkSyncSepolia },
    { env: "SRX_OFT_NATIVE_ZKSYNC",       eid: LZ_EIDS.zkSync },
  ];

  for (const peer of peerConfigs) {
    const peerAddress = process.env[peer.env];
    if (!peerAddress || peerAddress === tokenAddress) continue; // skip self

    console.log(`Setting peer: EID ${peer.eid} → ${peerAddress}`);
    const tx = await token.setPeer(peer.eid, addressToBytes32(peerAddress));
    await tx.wait();
    console.log(`✅ Peer set`);
  }

  console.log(`\n✅ Peers configured on ${network.name}`);
}

async function main() {
  const isOriginChain = network.name === "sepolia" || network.name === "ethereum";

  if (!isOriginChain) {
    // Step A: deploy on remote chain
    await deployNative();
  }

  // Step B/C: set peers (run after all OFTs deployed)
  const setPeersMode = process.env.SET_PEERS === "true";
  if (setPeersMode) {
    await setPeers();
  } else if (!isOriginChain) {
    console.log(`\nTo wire peers, re-run with SET_PEERS=true`);
  } else {
    console.log(`\nThis is the origin chain. Run with SET_PEERS=true after all remote OFTs are deployed.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
