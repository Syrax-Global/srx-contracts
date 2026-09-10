/**
 * mint_test_usdt.js
 *
 * Mints Sepolia testnet USDT directly from the Aave V3 faucet contract,
 * bypassing the broken Aave web UI.
 *
 * Aave faucet contract: 0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D
 * Aave USDT on Sepolia: 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0
 *
 * The faucet is permissionless — anyone can call mint(token, to, amount).
 * Deployer wallet pays the gas; USDT lands in INVESTOR wallet.
 *
 * Run:
 *   npx hardhat run scripts/ops/mint_test_usdt.js --network sepolia
 */

const { ethers, network } = require("hardhat");
require("dotenv").config();

const AAVE_FAUCET  = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";
const AAVE_USDT    = "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0";
const MINT_AMOUNT  = 100_000_000n; // 100 USDT (6 decimals)

const FAUCET_ABI = [
  "function mint(address token, address to, uint256 amount) external returns (uint256)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

async function main() {
  const [deployer] = await ethers.getSigners();

  // Recipient is the investor wallet
  const recipient = process.env.INVESTOR_PRIVATE_KEY
    ? new ethers.Wallet(process.env.INVESTOR_PRIVATE_KEY, ethers.provider).address
    : deployer.address;

  console.log(`\nNetwork:    ${network.name}`);
  console.log(`Deployer:   ${deployer.address} (pays gas)`);
  console.log(`Recipient:  ${recipient} (receives USDT)`);
  console.log(`Faucet:     ${AAVE_FAUCET}`);
  console.log(`USDT:       ${AAVE_USDT}\n`);

  const faucet = new ethers.Contract(AAVE_FAUCET, FAUCET_ABI, deployer);
  const usdt   = new ethers.Contract(AAVE_USDT,   ERC20_ABI,   deployer);

  // Pre-mint balance
  const balBefore = await usdt.balanceOf(recipient);
  console.log(`USDT balance before: ${ethers.formatUnits(balBefore, 6)} USDT`);

  // Mint
  console.log(`Minting ${ethers.formatUnits(MINT_AMOUNT, 6)} USDT to ${recipient}...`);
  const tx      = await faucet.mint(AAVE_USDT, recipient, MINT_AMOUNT);
  const receipt = await tx.wait();
  console.log(`✅ Minted — tx: ${receipt.hash}`);

  // Post-mint balance
  const balAfter = await usdt.balanceOf(recipient);
  console.log(`\nUSDT balance after:  ${ethers.formatUnits(balAfter, 6)} USDT`);
  console.log(`Delta:               +${ethers.formatUnits(balAfter - balBefore, 6)} USDT`);

  console.log(`\nUSDT contract (Sepolia): ${AAVE_USDT}`);
  console.log(`Next: run test_usdc_invest.js to test investWithUSDT()`);
}

main().catch((err) => {
  console.error("\n💥 Error:", err.message ?? err);
  process.exit(1);
});
