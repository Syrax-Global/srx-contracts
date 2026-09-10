/**
 * Generate a fresh Ethereum wallet for testnet testing.
 *
 * Run: npx hardhat run scripts/ops/gen_wallet.js
 *
 * The output address and private key are for TESTNET USE ONLY.
 * Never use a script-generated wallet on mainnet.
 *
 * After generating:
 * 1. Add to .env:  INVESTOR_PRIVATE_KEY=<private key>
 * 2. Fund with Sepolia ETH: https://sepoliafaucet.com
 * 3. Fund with Sepolia USDC: https://faucet.circle.com
 */
const { ethers } = require("hardhat");

async function main() {
  const wallet = ethers.Wallet.createRandom();

  console.log("\n── Fresh Testnet Wallet ─────────────────────────────────────");
  console.log(`Address:     ${wallet.address}`);
  console.log(`Private key: ${wallet.privateKey}`);
  console.log(`Mnemonic:    ${wallet.mnemonic?.phrase || "(not available)"}`);
  console.log("\n── Next steps ───────────────────────────────────────────────");
  console.log(`1. Add to .env:  INVESTOR_PRIVATE_KEY=${wallet.privateKey}`);
  console.log(`2. Fund with ETH:  https://sepoliafaucet.com`);
  console.log(`   → Paste address: ${wallet.address}`);
  console.log(`3. Fund with USDC: https://faucet.circle.com`);
  console.log(`   → Connect MetaMask using the private key above`);
  console.log(`   → Claim 20 USDC to: ${wallet.address}`);
  console.log("\n⚠️  TESTNET ONLY — never use this wallet on mainnet");
}

main().catch(console.error);
