/**
 * Step 1 — Deploy SRXToken (Ethereum / Sepolia)
 *
 * Deploys the canonical SRXToken OFT on the origin chain.
 * Does NOT call genesis() yet — that happens in Step 2 after all
 * vesting vaults and the TGEDistributor are deployed.
 *
 * Run: npx hardhat run scripts/deploy/01_deploy_token.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { LZ_ENDPOINTS, WALLETS } = require("./00_config");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying SRXToken on ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  const lzEndpoint = LZ_ENDPOINTS[network.name];
  if (!lzEndpoint) {
    throw new Error(`No LayerZero endpoint configured for network: ${network.name}`);
  }

  const admin = WALLETS.admin;
  console.log(`Admin:    ${admin}`);
  console.log(`LZ Endpoint: ${lzEndpoint}`);

  const SRXToken = await ethers.getContractFactory("SRXToken");
  const token = await SRXToken.deploy(lzEndpoint, admin);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log(`\nSRXToken deployed: ${address}`);
  console.log(`\n⚠️  Save this address to .env as SRX_TOKEN_${network.name.toUpperCase()}`);
  console.log(`⚠️  Do NOT call genesis() yet. Deploy vesting vaults first (Step 3).`);

  // Verify deployment basics
  const name     = await token.name();
  const symbol   = await token.symbol();
  const maxSupply = await token.MAX_SUPPLY();
  console.log(`\nToken:  ${name} (${symbol})`);
  console.log(`Supply: ${ethers.formatUnits(maxSupply, 18)} SRX`);
  console.log(`Genesis complete: ${await token.genesisComplete()}`);

  return address;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
